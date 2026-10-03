import { loadEnvironment } from "./config/loadEnvironment";
loadEnvironment();
const environment = process.env.APP_ENV ?? process.env.ENV ?? process.env.NODE_ENV ?? "development";
const legacyPrefix = environment.toUpperCase();
const first = (names: string[], fallback?: string) => names.map(name => process.env[name]).find(Boolean) ?? fallback;
const required = (names: string[]) => first(names) ?? (() => { throw new Error("Missing required configuration: " + names[0]); })();
const listValue = (primary: string, legacy: string[]) => {
  const source = process.env[primary] ?? legacy.map(name => process.env[name]).find(Boolean) ?? "";
  return source.split(",").map(item => item.trim()).filter(Boolean);
};
const normalizeUrl = (input: string, name: string) => { try { return new URL(input).toString().replace(/\/$/, ""); } catch { throw new Error(`Invalid URL in ${name}: ${input}`); } };
const enhasa = Object.freeze({
  url: normalizeUrl(required(["SERVICE_ENHASA_URL", `${legacyPrefix}_ENHASA_URL`]), "SERVICE_ENHASA_URL"),
  bootToken: required(["SERVICE_ENHASA_BOOT_TOKEN", `${legacyPrefix}_ENHASA_BOOT_TOKEN`]),
  timeoutMs: Number(first(["SERVICE_ENHASA_TIMEOUT_MS", `${legacyPrefix}_ENHASA_TIMEOUT_MS`], "3000")),
});
export const config = Object.freeze({
  app: Object.freeze({
    environment,
    port: Number(first(["APP_PORT", `${legacyPrefix}_PORT`, "PORT"], "3003")),
    publicUrl: normalizeUrl(first(["APP_PUBLIC_URL", `${legacyPrefix}_PUBLIC_URL`, "TOMA_PUBLIC_URL"], "ws://127.0.0.1:3003")!, "APP_PUBLIC_URL"),
    corsOrigins: Object.freeze(listValue("APP_CORS_ORIGINS", [`${legacyPrefix}_CORS_ORIGINS`, "CORS_ORIGINS"])),
  }),
  services: Object.freeze({ enhasa }),
  ttl: Object.freeze({
    defaultMs: Number(process.env.TOMA_DEFAULT_TTL_MS ?? 60000),
    minMs: Number(process.env.TOMA_MIN_TTL_MS ?? 1000),
    maxMs: Number(process.env.TOMA_MAX_TTL_MS ?? 300000),
  }),
  limits: Object.freeze({
    maxPayloadBytes: Number(process.env.TOMA_MAX_PAYLOAD_BYTES ?? 16384),
    maxBufferedBytes: Number(process.env.TOMA_MAX_BUFFERED_BYTES ?? 262144),
  }),
  cleanupIntervalMs: Number(process.env.TOMA_CLEANUP_INTERVAL_MS ?? 1000),
  // Transitional aliases.
  environment,
  port: Number(first(["APP_PORT", `${legacyPrefix}_PORT`, "PORT"], "3003")),
  publicUrl: normalizeUrl(first(["APP_PUBLIC_URL", `${legacyPrefix}_PUBLIC_URL`, "TOMA_PUBLIC_URL"], "ws://127.0.0.1:3003")!, "APP_PUBLIC_URL"),
  enhasa,
  maxPayloadBytes: Number(process.env.TOMA_MAX_PAYLOAD_BYTES ?? 16384),
  maxBufferedBytes: Number(process.env.TOMA_MAX_BUFFERED_BYTES ?? 262144),
  allowedOrigins: Object.freeze(listValue("APP_CORS_ORIGINS", [`${legacyPrefix}_CORS_ORIGINS`, "CORS_ORIGINS"])),
});
