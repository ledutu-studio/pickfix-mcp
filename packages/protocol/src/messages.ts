import { z } from 'zod';
import { APP_ID } from './constants.js';
import { batchReportSchema, batchSchema, batchStatusSchema, idSchema, sessionSchema } from './schemas.js';

const v = z.literal(1);
const timestamp = z.string().min(1).max(64);

export const errorCodeSchema = z.enum([
  'unauthorized',
  'protocol-mismatch',
  'invalid',
  'too-large',
  'rate-limited',
  'not-found',
  'conflict',
  'internal',
]);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v,
    type: z.literal('hello'),
    protocol: z.number().int(),
    client: z.object({ extensionVersion: z.string().max(50), browser: z.string().max(200) }),
  }),
  z.object({ v, type: z.literal('batch.submit'), requestId: idSchema, batch: batchSchema }),
  z.object({ v, type: z.literal('batch.watch'), batchIds: z.array(idSchema).max(500) }),
  z.object({ v, type: z.literal('batch.cancel'), requestId: idSchema, batchId: idSchema }),
  z.object({ v, type: z.literal('ping') }),
]);

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ v, type: z.literal('server.info'), app: z.literal(APP_ID), protocol: z.number().int(), serverVersion: z.string().max(50) }),
  z.object({ v, type: z.literal('welcome'), session: sessionSchema }),
  z.object({ v, type: z.literal('batch.accepted'), requestId: idSchema, batchId: idSchema, status: batchStatusSchema }),
  z.object({
    v,
    type: z.literal('batch.status'),
    batchId: idSchema,
    status: batchStatusSchema,
    note: z.string().max(500).optional(),
    report: batchReportSchema.optional(),
    updatedAt: timestamp,
  }),
  z.object({ v, type: z.literal('pong') }),
  z.object({ v, type: z.literal('error'), code: errorCodeSchema, requestId: idSchema.optional(), message: z.string().max(2000) }),
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string; ignore?: boolean };

function parseWith<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The message is not valid JSON.' };
  }
  const type = (data as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && type.startsWith('rpc.')) {
    return { ok: false, error: `Message type "${type}" is reserved for a later protocol version.`, ignore: true };
  }
  const result = schema.safeParse(data);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error).slice(0, 1000) };
  return { ok: true, message: result.data };
}

export function parseClientMessage(text: string): ParseResult<ClientMessage> {
  return parseWith(clientMessageSchema, text);
}

export function parseServerMessage(text: string): ParseResult<ServerMessage> {
  return parseWith(serverMessageSchema, text);
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
