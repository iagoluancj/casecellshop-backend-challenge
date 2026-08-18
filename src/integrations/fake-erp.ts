export class ErpTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErpTransientError";
  }
}

export class ErpTimeoutError extends Error {
  constructor(message = "ERP timeout") {
    super(message);
    this.name = "ErpTimeoutError";
  }
}

export type FakeErpBehavior =
  | { mode: "success" }
  | { mode: "fail_always" }
  | { mode: "fail_times"; times: number }
  | { mode: "timeout"; delayMs?: number };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ErpTimeoutError("ERP call aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Local adapter that simulates an external ERP.
 * processedOrderIds lives in process memory only: it is not a real ERP database
 * and is lost on restart. That is enough to exercise idempotency in this challenge.
 */
export class FakeErp {
  private readonly processedOrderIds = new Set<string>();
  private readonly attemptsByOrder = new Map<string, number>();

  constructor(private readonly behavior: FakeErpBehavior = { mode: "success" }) {}

  getAttempts(orderId: string): number {
    return this.attemptsByOrder.get(orderId) ?? 0;
  }

  wasProcessed(orderId: string): boolean {
    return this.processedOrderIds.has(orderId);
  }

  async processOrder(orderId: string, signal?: AbortSignal): Promise<void> {
    if (this.processedOrderIds.has(orderId)) {
      return;
    }

    this.attemptsByOrder.set(orderId, this.getAttempts(orderId) + 1);

    if (signal?.aborted) {
      throw new ErpTimeoutError("ERP call aborted");
    }

    switch (this.behavior.mode) {
      case "timeout":
        await sleep(this.behavior.delayMs ?? 60_000, signal);
        break;
      case "fail_always":
        throw new ErpTransientError("ERP unavailable");
      case "fail_times":
        if (this.getAttempts(orderId) <= this.behavior.times) {
          throw new ErpTransientError("ERP unavailable");
        }
        break;
      default:
        break;
    }

    if (signal?.aborted) {
      throw new ErpTimeoutError("ERP call aborted");
    }

    this.processedOrderIds.add(orderId);
  }
}

export function createDefaultFakeErp(): FakeErp {
  const mode = process.env.ERP_FAKE_MODE ?? "success";
  if (mode === "fail_always") {
    return new FakeErp({ mode: "fail_always" });
  }
  if (mode === "timeout") {
    return new FakeErp({ mode: "timeout" });
  }
  return new FakeErp({ mode: "success" });
}
