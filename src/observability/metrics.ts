import { ORDER_RECONCILIATION_STALE_MS } from "../config.js";
import type { Queue } from "bullmq";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import { prisma } from "../lib/prisma.js";

export const metricsRegistry = new Registry();

collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "casecellshop_process_",
});

const registers = [metricsRegistry];

export const cacheHitsTotal = new Counter({
  name: "casecellshop_cache_hits_total",
  help: "Catalog cache hits",
  registers,
});

export const cacheMissesTotal = new Counter({
  name: "casecellshop_cache_misses_total",
  help: "Catalog cache misses",
  registers,
});

export const cacheErrorsTotal = new Counter({
  name: "casecellshop_cache_errors_total",
  help: "Catalog cache errors and Redis fallbacks",
  registers,
});

export const checkoutTotal = new Counter({
  name: "casecellshop_checkout_total",
  help: "Checkout outcomes",
  labelNames: ["result"] as const,
  registers,
});

export const outboxPublishedTotal = new Counter({
  name: "casecellshop_outbox_published_total",
  help: "Outbox events successfully published to the queue",
  registers,
});

export const outboxPublishFailuresTotal = new Counter({
  name: "casecellshop_outbox_publish_failures_total",
  help: "Outbox publish attempts that failed to reach the queue",
  registers,
});

export const workerJobsTotal = new Counter({
  name: "casecellshop_worker_jobs_total",
  help: "Worker jobs that reached a terminal result",
  labelNames: ["result"] as const,
  registers,
});

export const workerRetriesTotal = new Counter({
  name: "casecellshop_worker_retries_total",
  help: "Worker attempts that will be retried by the queue",
  registers,
});

export const erpRequestsTotal = new Counter({
  name: "casecellshop_erp_requests_total",
  help: "Calls to the ERP integration",
  labelNames: ["result"] as const,
  registers,
});

export const stockCompensationsTotal = new Counter({
  name: "casecellshop_stock_compensations_total",
  help: "Stock compensations executed after definitive order failure",
  registers,
});

export const reconciliationTotal = new Counter({
  name: "casecellshop_reconciliation_total",
  help: "Stale PROCESSING order reconciliations",
  labelNames: ["result"] as const,
  registers,
});

export const httpRequestDurationSeconds = new Histogram({
  name: "casecellshop_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers,
});

export const erpRequestDurationSeconds = new Histogram({
  name: "casecellshop_erp_request_duration_seconds",
  help: "ERP integration duration in seconds",
  labelNames: ["result"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers,
});

export const workerProcessingDurationSeconds = new Histogram({
  name: "casecellshop_worker_processing_duration_seconds",
  help: "Worker processing duration in seconds for terminal outcomes",
  labelNames: ["result"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers,
});

let metricsQueue: Queue | null = null;

export function bindQueueMetrics(queue: Queue | null): void {
  metricsQueue = queue;
}

new Gauge({
  name: "casecellshop_queue_waiting_jobs",
  help: "Current jobs waiting in the order-processing queue",
  registers,
  async collect() {
    if (!metricsQueue) {
      this.set(0);
      return;
    }

    try {
      this.set(await metricsQueue.getWaitingCount());
    } catch {
      this.set(0);
    }
  },
});

new Gauge({
  name: "casecellshop_orders_pending",
  help: "Current orders with status PENDING",
  registers,
  async collect() {
    try {
      this.set(await prisma.order.count({ where: { status: "PENDING" } }));
    } catch {
      this.set(0);
    }
  },
});

new Gauge({
  name: "casecellshop_orders_processing",
  help: "Current orders with status PROCESSING",
  registers,
  async collect() {
    try {
      this.set(await prisma.order.count({ where: { status: "PROCESSING" } }));
    } catch {
      this.set(0);
    }
  },
});

new Gauge({
  name: "casecellshop_stale_processing_orders",
  help: "PROCESSING orders older than ORDER_RECONCILIATION_STALE_MS",
  registers,
  async collect() {
    try {
      this.set(
        await prisma.order.count({
          where: {
            status: "PROCESSING",
            updatedAt: {
              lt: new Date(Date.now() - ORDER_RECONCILIATION_STALE_MS),
            },
          },
        }),
      );
    } catch {
      this.set(0);
    }
  },
});

export async function renderMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

export async function readMetricValue(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(name);
  if (!metric) {
    return 0;
  }

  const snapshot = await metric.get();
  const match = snapshot.values.find((entry) =>
    Object.entries(labels).every(
      ([key, value]) => entry.labels[key] === value,
    ),
  );

  return match?.value ?? 0;
}
