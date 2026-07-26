import type { ApiError } from "@amber/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { DomainError } from "../domain/errors.ts";

/**
 * Route level validation. Bodies, queries, and params are parsed with the zod
 * schemas from shared/src/apiTypes.ts, so the wire contract has exactly one
 * definition and the client infers its types from the same file.
 */

function issueDetails(error: z.ZodError): Record<string, unknown> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    fields[path === "" ? "(root)" : path] = issue.message;
  }
  return { fields };
}

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  throw new DomainError("invalid", `Invalid ${what}.`, issueDetails(result.error));
}

export function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return parse(schema, request.body ?? {}, "request body");
}

export function parseQuery<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return parse(schema, request.query ?? {}, "query string");
}

export function parseParams<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return parse(schema, request.params ?? {}, "path");
}

/**
 * Translate a thrown error into the shared ApiError shape.
 *
 * Only 4xx messages are passed through. A 5xx is reported as a fixed string
 * and the real error goes to the log instead, because an unexpected failure
 * can carry anything in its message and API responses must never become a
 * side channel for it.
 */
export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: String((error as { code?: unknown }).code ?? "bad_request"),
        message: error instanceof Error ? error.message : "The request could not be processed.",
      },
    };
  }

  return {
    status: 500,
    body: { error: "internal", message: "Something went wrong. Check the server logs." },
  };
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const { status, body } = toApiError(error);
  return reply.code(status).send(body);
}
