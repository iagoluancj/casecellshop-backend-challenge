export function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export const ORDER_QUEUE_NAME = "order-processing";
export const ORDER_JOB_NAME = "process-order";
export const OUTBOX_TYPE_PROCESS_ORDER = "PROCESS_ORDER";

export const OUTBOX_POLL_INTERVAL_MS = envInt("OUTBOX_POLL_INTERVAL_MS", 1000);
export const ERP_TIMEOUT_MS = envInt("ERP_TIMEOUT_MS", 1000);
export const ORDER_JOB_ATTEMPTS = envInt("ORDER_JOB_ATTEMPTS", 3);
export const ORDER_JOB_BACKOFF_MS = envInt("ORDER_JOB_BACKOFF_MS", 200);
