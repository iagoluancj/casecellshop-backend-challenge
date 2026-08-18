import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

async function resetDatabase() {
  await prisma.outboxEvent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
}

async function createProduct(data: {
  name: string;
  price: string;
  stock: number;
}) {
  return prisma.product.create({
    data: {
      externalId: `test-${randomUUID()}`,
      name: data.name,
      price: data.price,
      stock: data.stock,
    },
  });
}

describe("POST /checkout", () => {
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

  it("cria pedido, itens e decrementa estoque", async () => {
    const product = await createProduct({
      name: "Capinha A",
      price: "10.00",
      stock: 10,
    });

    const response = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        items: [{ productId: product.id, quantity: 2 }],
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { orderId: string; status: string };
    expect(body.status).toBe("PENDING");

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: body.orderId },
      include: { items: true },
    });
    expect(order.total.toFixed(2)).toBe("20.00");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]?.quantity).toBe(2);
    expect(order.items[0]?.unitPrice.toFixed(2)).toBe("10.00");

    const outbox = await prisma.outboxEvent.findMany({
      where: { orderId: body.orderId },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.type).toBe("PROCESS_ORDER");
    expect(outbox[0]?.status).toBe("PENDING");
    expect(outbox[0]?.payload).toMatchObject({ orderId: body.orderId });
    expect(
      typeof (outbox[0]?.payload as { correlationId?: string }).correlationId,
    ).toBe("string");

    const updated = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(updated.stock).toBe(8);
  });

  it("rejeita estoque insuficiente sem criar pedido", async () => {
    const product = await createProduct({
      name: "Capinha B",
      price: "10.00",
      stock: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        items: [{ productId: product.id, quantity: 2 }],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);

    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(unchanged.stock).toBe(1);
  });

  it("faz rollback se um dos produtos não tiver estoque", async () => {
    const productA = await createProduct({
      name: "Produto A",
      price: "10.00",
      stock: 5,
    });
    const productB = await createProduct({
      name: "Produto B",
      price: "15.00",
      stock: 0,
    });

    const response = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        items: [
          { productId: productA.id, quantity: 1 },
          { productId: productB.id, quantity: 1 },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productA.id } }))
        .stock,
    ).toBe(5);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productB.id } }))
        .stock,
    ).toBe(0);
  });

  it("replay sequencial com a mesma chave não duplica pedido nem estoque", async () => {
    const product = await createProduct({
      name: "Capinha C",
      price: "10.00",
      stock: 10,
    });
    const key = randomUUID();
    const payload = {
      items: [{ productId: product.id, quantity: 2 }],
    };

    const first = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": key },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": key },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().orderId).toBe(second.json().orderId);
    expect(await prisma.order.count()).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(8);
  });

  it("duas compras concorrentes não deixam estoque negativo", async () => {
    const product = await createProduct({
      name: "Última unidade",
      price: "10.00",
      stock: 1,
    });
    const payload = {
      items: [{ productId: product.id, quantity: 1 }],
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": randomUUID() },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": randomUUID() },
        payload,
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([202, 409]);
    expect(await prisma.order.count()).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(0);
  });

  it("duas requests concorrentes com a mesma chave criam uma única Order", async () => {
    const product = await createProduct({
      name: "Capinha D",
      price: "10.00",
      stock: 5,
    });
    const key = randomUUID();
    const payload = {
      items: [{ productId: product.id, quantity: 1 }],
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": key },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": key },
        payload,
      }),
    ]);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().orderId).toBe(second.json().orderId);
    expect(await prisma.order.count()).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(4);
  });

  it("mesma chave concorrente com estoque just-enough devolve um único pedido", async () => {
    const product = await createProduct({
      name: "Capinha E",
      price: "10.00",
      stock: 1,
    });
    const key = randomUUID();
    const payload = {
      items: [{ productId: product.id, quantity: 1 }],
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": key },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": key },
        payload,
      }),
    ]);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().orderId).toBe(second.json().orderId);
    expect(await prisma.order.count()).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stock,
    ).toBe(0);
  });

  it("rejeita a mesma chave com payload diferente", async () => {
    const productA = await createProduct({
      name: "Produto A",
      price: "10.00",
      stock: 5,
    });
    const productB = await createProduct({
      name: "Produto B",
      price: "20.00",
      stock: 5,
    });
    const key = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": key },
      payload: {
        items: [{ productId: productA.id, quantity: 1 }],
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": key },
      payload: {
        items: [{ productId: productB.id, quantity: 5 }],
      },
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await prisma.order.count()).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productA.id } }))
        .stock,
    ).toBe(4);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productB.id } }))
        .stock,
    ).toBe(5);
  });
});
