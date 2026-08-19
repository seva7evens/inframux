import { z } from 'zod';

export const PROTOCOL_VERSION = Object.freeze({ major: 1 as const, minor: 1 as const });
export const MINIMUM_PROTOCOL_MINOR = 0;

const protocolSchema = z.object({
  major: z.number().int(),
  minor: z.number().int(),
}).strict();

const requestSchema = z.object({
  kind: z.literal('request'),
  protocol: protocolSchema,
  id: z.uuid(),
  deadlineMs: z.number().int().positive(),
  operation: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  payload: z.json(),
}).strict();

const successSchema = z.object({
  kind: z.literal('response'),
  protocol: protocolSchema,
  id: z.uuid(),
  ok: z.literal(true),
  result: z.json(),
}).strict();

const failureSchema = z.object({
  kind: z.literal('response'),
  protocol: protocolSchema,
  id: z.uuid(),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(2048),
  }).strict(),
}).strict();

const cancelSchema = z.object({
  kind: z.literal('cancel'),
  protocol: protocolSchema,
  id: z.uuid(),
}).strict();

const wireMessageSchema = z.union([
  requestSchema,
  successSchema,
  failureSchema,
  cancelSchema,
]);

export type RequestMessage = z.infer<typeof requestSchema>;
export type ResponseMessage = z.infer<typeof successSchema> | z.infer<typeof failureSchema>;
export type CancelMessage = z.infer<typeof cancelSchema>;
export type WireMessage = RequestMessage | ResponseMessage | CancelMessage;

export function parseWireMessage(value: unknown): WireMessage {
  try {
    const message = wireMessageSchema.parse(value) as WireMessage;
    if (
      message.protocol.major !== PROTOCOL_VERSION.major ||
      message.protocol.minor < MINIMUM_PROTOCOL_MINOR ||
      message.protocol.minor > PROTOCOL_VERSION.minor
    ) {
      throw new Error(
        `Unsupported protocol ${message.protocol.major}.${message.protocol.minor}; supported 1.0..1.1`,
      );
    }
    return message;
  } catch (error) {
    if (error instanceof Error && /protocol/i.test(error.message)) throw error;
    throw new Error(`Invalid protocol message: ${error instanceof Error ? error.message : 'schema failure'}`, {
      cause: error,
    });
  }
}
