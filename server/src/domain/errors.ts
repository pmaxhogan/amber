/**
 * Domain level failures that map onto HTTP status codes. Routes translate
 * these into the shared ApiError shape; nothing else in the domain layer knows
 * about Fastify.
 *
 * Messages are user facing, so they must never contain credential material.
 */
export type DomainErrorCode =
  "not_found" | "conflict" | "invalid" | "immutable" | "unsupported" | "precondition_failed";

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  immutable: 409,
  unsupported: 400,
  precondition_failed: 412,
};

export class DomainError extends Error {
  override readonly name = "DomainError";
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function notFound(what: string, id: number | string): DomainError {
  return new DomainError("not_found", `${what} ${String(id)} does not exist.`);
}

export function conflict(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("conflict", message, details);
}

export function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("invalid", message, details);
}

/** True for a sqlite UNIQUE or PRIMARY KEY violation. */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === "ERR_SQLITE_ERROR" &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("PRIMARY KEY must be unique"))
  );
}

/** True for a sqlite foreign key violation, including ON DELETE RESTRICT. */
export function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("FOREIGN KEY constraint failed");
}
