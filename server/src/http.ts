import type { FastifyReply } from "fastify";
import type { z } from "zod";

// An error with the HTTP status the API should answer with.
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  void reply.code(400).send({ error: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  return null;
}
