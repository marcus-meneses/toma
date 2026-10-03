import { z } from "zod";
export const eventSchema = z.object({
  type: z.string().trim().min(1).max(100),
  scope: z.string().trim().min(1).max(100),
  entityId: z.string().trim().min(1).max(200).optional(),
  revision: z.number().int().nonnegative().optional(),
  coalesce: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional()
}).strict();
export const publishSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().trim().min(1).max(200),
  recipientOperatorIds: z.array(z.string().trim().min(1).max(200)).max(1000),
  event: eventSchema,
  ttlMs: z.number().int().positive().optional()
}).strict();
export const ackSchema = z.object({ kind: z.literal("ack"), notificationId: z.string().uuid() }).strict();
export type PublishInput = z.infer<typeof publishSchema>;
export type EventPayload = z.infer<typeof eventSchema>;
