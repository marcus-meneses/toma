import { createHash } from "crypto";
import type { EventPayload, PublishInput } from "./protocol";

export type Clock = { now(): number };
export type ServerEnvelope = { kind: "notification"; id: string; tenantId: string; event: EventPayload; expiresAt: string };
type Pending = PublishInput & { expiresAtMs: number; pendingOperators: Set<string>; contentHash: string };
export type PublishResult = { id: string; accepted: true; recipientCount: number; connectedRecipientCount: number; expiresAt: string; duplicate?: boolean };
export type DeliveryMetrics = { accepted: number; completed: number; expired: number; acknowledgements: number; duplicates: number; retries: number; pendingRecipients: number };

const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unique = (values: string[]) => [...new Set(values)];

export class DeliveryStore {
  private readonly pending = new Map<string, Pending>();
  private readonly byOperator = new Map<string, Set<string>>();
  private readonly coalescing = new Map<string, string>();
  readonly metrics: DeliveryMetrics = { accepted: 0, completed: 0, expired: 0, acknowledgements: 0, duplicates: 0, retries: 0, pendingRecipients: 0 };

  constructor(private readonly clock: Clock, private readonly send: (tenantId: string, operatorId: string, envelope: ServerEnvelope) => number) {}

  publish(input: PublishInput, ttlMs: number): PublishResult {
    const contentHash = stableHash(input);
    const duplicate = this.pending.get(input.id);
    if (duplicate) {
      if (duplicate.contentHash !== contentHash) throw Object.assign(new Error("Notification ID conflict"), { status: 409 });
      this.metrics.duplicates++;
      return this.result(duplicate, true);
    }

    const operators = unique(input.recipientOperatorIds);
    const pending: Pending = { ...input, recipientOperatorIds: operators, expiresAtMs: this.clock.now() + ttlMs, pendingOperators: new Set(operators), contentHash };
    if (!operators.length) {
      return { id: input.id, accepted: true, recipientCount: 0, connectedRecipientCount: 0, expiresAt: new Date(pending.expiresAtMs).toISOString() };
    }

    if (input.event.coalesce && typeof input.event.revision === "number") this.coalesce(pending);
    this.pending.set(input.id, pending);
    for (const operatorId of pending.pendingOperators) {
      const ids = this.byOperator.get(operatorId) ?? new Set<string>();
      ids.add(input.id); this.byOperator.set(operatorId, ids);
    }
    this.metrics.accepted++;
    this.recount();
    let connected = 0;
    for (const operatorId of pending.pendingOperators) if (this.send(pending.tenantId, operatorId, this.envelope(pending)) > 0) connected++;
    return { ...this.result(pending), connectedRecipientCount: connected };
  }

  acknowledge(notificationId: string, operatorId: string, tenantId: string): boolean {
    const item = this.pending.get(notificationId);
    if (!item || item.tenantId !== tenantId || !item.pendingOperators.has(operatorId) || item.expiresAtMs <= this.clock.now()) return false;
    item.pendingOperators.delete(operatorId);
    this.byOperator.get(operatorId)?.delete(notificationId);
    this.metrics.acknowledgements++;
    if (!item.pendingOperators.size) this.complete(item);
    this.recount();
    return true;
  }

  retry(operatorId: string, tenantId: string): number {
    let sent = 0;
    for (const id of this.byOperator.get(operatorId) ?? []) {
      const item = this.pending.get(id);
      if (item && item.tenantId === tenantId && item.expiresAtMs > this.clock.now()) {
        sent += this.send(item.tenantId, operatorId, this.envelope(item));
        this.metrics.retries++;
      }
    }
    return sent;
  }

  cleanup(): number {
    let expired = 0;
    for (const item of this.pending.values()) {
      if (item.expiresAtMs <= this.clock.now()) { this.remove(item); this.metrics.expired++; expired++; }
    }
    this.recount();
    return expired;
  }

  has(id: string) { return this.pending.has(id); }
  pendingCount() { return this.pending.size; }
  memoryEstimate() { return [...this.pending.values()].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + item.pendingOperators.size * 64, 0); }

  private coalesce(incoming: Pending) {
    for (const operatorId of [...incoming.pendingOperators]) {
      const key = incoming.tenantId + ":" + operatorId + ":" + incoming.event.type + ":" + incoming.event.scope;
      const previousId = this.coalescing.get(key);
      const previous = previousId ? this.pending.get(previousId) : undefined;
      if (previous && Number(previous.event.revision) > Number(incoming.event.revision)) {
        incoming.pendingOperators.delete(operatorId);
        continue;
      }
      if (previous) {
        previous.pendingOperators.delete(operatorId);
        this.byOperator.get(operatorId)?.delete(previous.id);
        if (!previous.pendingOperators.size) this.complete(previous);
      }
      this.coalescing.set(key, incoming.id);
    }
  }

  private complete(item: Pending) { this.remove(item); this.metrics.completed++; }
  private remove(item: Pending) {
    this.pending.delete(item.id);
    for (const operatorId of item.recipientOperatorIds) {
      this.byOperator.get(operatorId)?.delete(item.id);
      if (!this.byOperator.get(operatorId)?.size) this.byOperator.delete(operatorId);
      const key = item.tenantId + ":" + operatorId + ":" + item.event.type + ":" + item.event.scope;
      if (this.coalescing.get(key) === item.id) this.coalescing.delete(key);
    }
  }
  private recount() { this.metrics.pendingRecipients = [...this.pending.values()].reduce((sum, item) => sum + item.pendingOperators.size, 0); }
  private envelope(item: Pending): ServerEnvelope { return { kind: "notification", id: item.id, tenantId: item.tenantId, event: item.event, expiresAt: new Date(item.expiresAtMs).toISOString() }; }
  private result(item: Pending, duplicate = false): PublishResult {
    return { id: item.id, accepted: true, recipientCount: item.recipientOperatorIds.length, connectedRecipientCount: 0, expiresAt: new Date(item.expiresAtMs).toISOString(), ...(duplicate ? { duplicate: true } : {}) };
  }
}
