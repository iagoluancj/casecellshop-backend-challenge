import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeErp } from "../src/integrations/fake-erp.js";
import { metricsRegistry, readMetricValue } from "../src/observability/metrics.js";
import { invalidateProductsCache } from "../src/services/product-service.js";
import { processOrder } from "../src/services/process-order-service.js";
import {
  createPendingOrder,
  createProduct,
  resetDatabase,
  silentLogger,
} from "./helpers.js";

describe("observability", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    await invalidateProductsCache();
  });

  it("GET /metrics expõe o registry Prometheus", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      metricsRegistry.contentType.split(";")[0],
    );
    expect(response.body).toContain("casecellshop_");
    expect(response.body).toContain("casecellshop_cache_hits_total");
    expect(response.body).toContain("casecellshop_http_request_duration_seconds");
    expect(response.body).toContain("casecellshop_reconciliation_total");
    expect(response.body).toContain("casecellshop_stale_processing_orders");
  });

  it("GET /products incrementa miss e depois hit", async () => {
    await createProduct({
      name: "Capinha Métricas",
      price: "10.00",
      stock: 3,
    });

    const missesBefore = await readMetricValue("casecellshop_cache_misses_total");
    const hitsBefore = await readMetricValue("casecellshop_cache_hits_total");

    const miss = await app.inject({ method: "GET", url: "/products" });
    expect(miss.statusCode).toBe(200);
    expect(await readMetricValue("casecellshop_cache_misses_total")).toBe(
      missesBefore + 1,
    );

    const hit = await app.inject({ method: "GET", url: "/products" });
    expect(hit.statusCode).toBe(200);
    expect(await readMetricValue("casecellshop_cache_hits_total")).toBe(
      hitsBefore + 1,
    );
  });

  it("checkout bem-sucedido incrementa result=accepted", async () => {
    const product = await createProduct({
      name: "Capinha Checkout Métrica",
      price: "10.00",
      stock: 4,
    });
    const before = await readMetricValue("casecellshop_checkout_total", {
      result: "accepted",
    });

    const response = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: {
        "idempotency-key": randomUUID(),
        "x-correlation-id": "corr-metrics-checkout",
      },
      payload: {
        items: [{ productId: product.id, quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["x-correlation-id"]).toBe("corr-metrics-checkout");
    expect(
      await readMetricValue("casecellshop_checkout_total", {
        result: "accepted",
      }),
    ).toBe(before + 1);
  });

  it("ERP Fake sucesso e falha incrementam counters correspondentes", async () => {
    const logger = silentLogger();
    const product = await createProduct({
      name: "Capinha ERP Métrica",
      price: "10.00",
      stock: 5,
    });
    const successOrder = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });
    const failedOrder = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });

    const successBefore = await readMetricValue("casecellshop_erp_requests_total", {
      result: "success",
    });
    const errorBefore = await readMetricValue("casecellshop_erp_requests_total", {
      result: "error",
    });
    const completedBefore = await readMetricValue("casecellshop_worker_jobs_total", {
      result: "completed",
    });
    const failedBefore = await readMetricValue("casecellshop_worker_jobs_total", {
      result: "failed",
    });

    await processOrder(successOrder.id, {
      erp: new FakeErp({ mode: "success" }),
      logger,
      isLastAttempt: false,
      correlationId: "corr-erp-success",
    });

    await expect(
      processOrder(failedOrder.id, {
        erp: new FakeErp({ mode: "fail_always" }),
        logger,
        isLastAttempt: true,
        correlationId: "corr-erp-error",
      }),
    ).rejects.toThrow("ERP unavailable");

    expect(
      await readMetricValue("casecellshop_erp_requests_total", {
        result: "success",
      }),
    ).toBe(successBefore + 1);
    expect(
      await readMetricValue("casecellshop_erp_requests_total", {
        result: "error",
      }),
    ).toBe(errorBefore + 1);
    expect(
      await readMetricValue("casecellshop_worker_jobs_total", {
        result: "completed",
      }),
    ).toBe(completedBefore + 1);
    expect(
      await readMetricValue("casecellshop_worker_jobs_total", {
        result: "failed",
      }),
    ).toBe(failedBefore + 1);
  });
});
