import { randomUUID } from "node:crypto";

const MAX_CORRELATION_ID_LENGTH = 128;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function resolveCorrelationId(header: unknown): string {
  if (typeof header !== "string") {
    return randomUUID();
  }

  const value = header.trim();
  if (
    value.length === 0 ||
    value.length > MAX_CORRELATION_ID_LENGTH ||
    !CORRELATION_ID_PATTERN.test(value)
  ) {
    return randomUUID();
  }

  return value;
}
