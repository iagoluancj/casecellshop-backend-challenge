import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createPendingOrder, createProduct, resetDatabase } from "./helpers.js";

describe("GET /orders/:orderId/status", () => {
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
  });

  it("retorna PENDING para um pedido existente", async () => {
    const product = await createProduct({
      name: "Capinha Status",
      price: "10.00",
      stock: 5,
    });
    const order = await createPendingOrder({
      productId: product.id,
      quantity: 1,
    });

    const response = await app.inject({
      method: "GET",
      url: `/orders/${order.id}/status`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      orderId: order.id,
      status: "PENDING",
    });
  });

  it("retorna 404 quando o pedido não existe", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/orders/${randomUUID()}/status`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "ORDER_NOT_FOUND",
      message: "Pedido não encontrado",
    });
  });
});
