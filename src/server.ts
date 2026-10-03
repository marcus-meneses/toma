import { createServer, IncomingMessage } from "http";
import { timingSafeEqual } from "crypto";
import express, { Request } from "express";
import jwt from "jsonwebtoken";
import { RawData, WebSocket, WebSocketServer } from "ws";
import { bootstrapUntilReady, credentials } from "./bootstrap";
import { config } from "./config";
import { DeliveryStore, ServerEnvelope } from "./delivery";
import { ackSchema, publishSchema } from "./protocol";

type SocketContext = { id: string; operatorId: string; tenantId: string; expiresAtMs: number; socket: WebSocket };
const app = express();
app.use(express.json({ limit: config.maxPayloadBytes }));
const server = createServer(app);
const sockets = new Map<string, SocketContext>();
const index = new Map<string, Map<string, Set<string>>>();
const consumedNonces = new Map<string, number>();
const counters = { authFailures: 0, connections: 0, slowDisconnects: 0, malformedFrames: 0 };
const rate = new Map<string, { start: number; count: number }>();
const allow = (key: string, limit: number, windowMs: number) => {
  const now = Date.now(); const current = rate.get(key);
  if (!current || current.start + windowMs <= now) { rate.set(key, { start: now, count: 1 }); return true; }
  current.count++; return current.count <= limit;
};
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const sendOperator = (tenantId: string, operatorId: string, envelope: ServerEnvelope): number => {
  let sent = 0;
  const operators = index.get(tenantId);
  for (const id of operators?.get(operatorId) ?? []) {
    const context = sockets.get(id);
    if (!context || context.socket.readyState !== WebSocket.OPEN) continue;
    if (context.socket.bufferedAmount > config.maxBufferedBytes) { counters.slowDisconnects++; context.socket.close(1013, "Backpressure"); continue; }
    context.socket.send(JSON.stringify(envelope)); sent++;
  }
  return sent;
};
const store = new DeliveryStore({ now: () => Date.now() }, sendOperator);
const bearer = (req: Request) => {
  const [scheme, token] = (req.header("authorization") ?? "").split(" ");
  return scheme === "Bearer" ? token : "";
};
const master = (req: Request, res: express.Response, next: express.NextFunction) => {
  const state = credentials();
  if (!state) { res.status(503).json({ message: "Service not ready" }); return; }
  if (!allow("http:" + (req.ip ?? "unknown"), 120, 60000) || !safeEqual(bearer(req), state.masterToken)) {
    counters.authFailures++; res.status(401).json({ message: "Unauthorized" }); return;
  }
  next();
};

app.get("/liveness", (_req, res) => res.json({ status: "alive" }));
app.get("/readiness", (_req, res) => res.status(credentials() ? 200 : 503).json({ status: credentials() ? "ready" : "unready" }));
app.post("/internal/v1/notifications", master, (req, res) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(req.body)) > config.maxPayloadBytes) { res.status(400).json({ message: "Invalid notification" }); return; }
  const ttlMs = Math.max(config.ttl.minMs, Math.min(config.ttl.maxMs, parsed.data.ttlMs ?? config.ttl.defaultMs));
  try { res.status(202).json(store.publish(parsed.data, ttlMs)); }
  catch (error) { res.status((error as { status?: number }).status ?? 500).json({ message: error instanceof Error ? error.message : "Publish failed" }); }
});
app.get("/internal/v1/metrics", master, (_req, res) => {
  const tenantConnections = [...index.values()].reduce((sum, operators) => sum + [...operators.values()].reduce((n, ids) => n + ids.size, 0), 0);
  res.json({ ...counters, ...store.metrics, activeConnections: sockets.size, indexedConnections: tenantConnections, pendingNotifications: store.pendingCount(), pendingMemoryEstimateBytes: store.memoryEstimate(), bootstrapReady: Boolean(credentials()) });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes, perMessageDeflate: false });
const remove = (context: SocketContext) => {
  sockets.delete(context.id);
  const operators = index.get(context.tenantId);
  operators?.get(context.operatorId)?.delete(context.id);
  if (!operators?.get(context.operatorId)?.size) operators?.delete(context.operatorId);
  if (!operators?.size) index.delete(context.tenantId);
};
wss.on("connection", (socket: WebSocket, _request: IncomingMessage, context: SocketContext) => {
  sockets.set(context.id, context);
  const operators = index.get(context.tenantId) ?? new Map<string, Set<string>>();
  const ids = operators.get(context.operatorId) ?? new Set<string>(); ids.add(context.id);
  operators.set(context.operatorId, ids); index.set(context.tenantId, operators);
  counters.connections++; store.retry(context.operatorId, context.tenantId);
  socket.on("message", (raw: RawData) => {
    if (!allow("ack:" + context.id, 120, 60000)) { socket.close(1008, "Rate limit"); return; }
    try {
      const parsed = ackSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success || !store.acknowledge(parsed.data.notificationId, context.operatorId, context.tenantId)) { counters.malformedFrames++; socket.close(1008, "Invalid acknowledgement"); }
    } catch { counters.malformedFrames++; socket.close(1007, "Malformed JSON"); }
  });
  socket.on("close", () => remove(context)); socket.on("error", () => remove(context));
});
server.on("upgrade", (request, socket, head) => {
  const state = credentials();
  if (!state) { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return; }
  const ip = request.socket.remoteAddress ?? "unknown";
  if (!allow("ws:" + ip, 30, 60000)) { socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); socket.destroy(); return; }
  try {
    const origin = request.headers.origin;
    if (config.allowedOrigins.length && (!origin || !config.allowedOrigins.includes(origin))) throw new Error("Origin not allowed");
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/socket") throw new Error("Unknown socket path");
    const ticket = url.searchParams.get("ticket");
    if (!ticket) throw new Error("Missing ticket");
    const payload = jwt.verify(ticket, state.validation.publicKey, { algorithms: [state.validation.algorithm], audience: "toma", issuer: state.validation.issuer }) as jwt.JwtPayload & { operatorId: string; tenantId: string; credentialVersion: string; clientCredentialHash: string; nonce: string; typ: string; sessionExpiresAt: number };
    if (payload.typ !== "toma-socket" || payload.credentialVersion !== state.version || !safeEqual(payload.clientCredentialHash, state.clientTokenHash) || !payload.nonce || consumedNonces.has(payload.nonce)) throw new Error("Invalid ticket");
    consumedNonces.set(payload.nonce, Number(payload.exp) * 1000);
    const context: SocketContext = { id: payload.jti!, operatorId: payload.operatorId, tenantId: payload.tenantId, expiresAtMs: payload.sessionExpiresAt, socket: null as unknown as WebSocket };
    wss.handleUpgrade(request, socket, head, ws => { context.socket = ws; wss.emit("connection", ws, request, context); });
  } catch { counters.authFailures++; socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); }
});
setInterval(() => {
  const now = Date.now(); store.cleanup();
  for (const [nonce, expiry] of consumedNonces) if (expiry <= now) consumedNonces.delete(nonce);
  for (const context of sockets.values()) if (context.expiresAtMs <= now) context.socket.close(1008, "Ticket expired");
}, config.cleanupIntervalMs).unref();

server.listen(config.port, () => {
  console.log("Toma listening on port " + config.port);
  void bootstrapUntilReady();
});
const shutdown = () => { for (const context of sockets.values()) context.socket.close(1001, "Server shutdown"); server.close(); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
