import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryStore, ServerEnvelope } from "../src/delivery";
import type { PublishInput } from "../src/protocol";
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const input = (n = 1, revision = 1): PublishInput => ({ id: id(n), tenantId: "tenant-a", recipientOperatorIds: ["operator-a"], event: { type: "kanban.changed", scope: "grooming", revision, coalesce: true } });
test("delivers to every active session and one operator ack completes", () => {
  let now = 1000; const frames: ServerEnvelope[] = [];
  const store = new DeliveryStore({ now: () => now }, (_tenant, _operator, frame) => { frames.push(frame, frame); return 2; });
  assert.equal(store.publish(input(), 1000).connectedRecipientCount, 1);
  assert.equal(frames.length, 2);
  assert.equal(store.acknowledge(id(1), "operator-a", "tenant-a"), true);
  assert.equal(store.pendingCount(), 0);
});
test("pending retries on reconnect and expires deterministically", () => {
  let now = 1000, sends = 0;
  const store = new DeliveryStore({ now: () => now }, () => { sends++; return 1; });
  store.publish(input(), 1000); assert.equal(store.retry("operator-a", "tenant-a"), 1);
  now = 2001; assert.equal(store.cleanup(), 1); assert.equal(store.pendingCount(), 0); assert.equal(sends, 2);
});
test("duplicate IDs are idempotent and conflicting content is rejected", () => {
  const store = new DeliveryStore({ now: () => 0 }, () => 0);
  store.publish(input(), 1000); assert.equal(store.publish(input(), 1000).duplicate, true);
  assert.throws(() => store.publish({ ...input(), tenantId: "tenant-b" }, 1000), /conflict/);
});
test("older revisions cannot replace newer coalesced notifications", () => {
  const store = new DeliveryStore({ now: () => 0 }, () => 0);
  store.publish(input(2, 10), 1000); store.publish(input(3, 9), 1000);
  assert.equal(store.has(id(2)), true); assert.equal(store.has(id(3)), true);
  assert.equal(store.acknowledge(id(3), "operator-a", "tenant-a"), false);
});
test("tenant and operator scoped acknowledgements are enforced", () => {
  const store = new DeliveryStore({ now: () => 0 }, () => 0); store.publish(input(), 1000);
  assert.equal(store.acknowledge(id(1), "operator-b", "tenant-a"), false);
  assert.equal(store.acknowledge(id(1), "operator-a", "tenant-b"), false);
});
