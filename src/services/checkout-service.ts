import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { OUTBOX_TYPE_PROCESS_ORDER } from "../config.js";
import { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http-error.js";
import { prisma } from "../lib/prisma.js";
import { invalidateProductsCache } from "./product-service.js";

export type CheckoutItemInput = {
  productId: string;
  quantity: number;
};

export type CheckoutAccepted = {
  orderId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
};

export function normalizeCheckoutItems(
  items: CheckoutItemInput[],
): CheckoutItemInput[] {
  const quantities = new Map<string, number>();

  for (const item of items) {
    const productId = item.productId.trim();
    quantities.set(productId, (quantities.get(productId) ?? 0) + item.quantity);
  }

  return [...quantities.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
}

export function createCheckoutFingerprint(items: CheckoutItemInput[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

async function existingCheckoutResponse(
  idempotencyKey: string,
  fingerprint: string,
): Promise<CheckoutAccepted | null> {
  const existing = await prisma.order.findUnique({
    where: { idempotencyKey },
  });

  if (!existing) {
    return null;
  }

  if (existing.requestFingerprint !== fingerprint) {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key already used with a different checkout payload",
    );
  }

  return {
    orderId: existing.id,
    status: existing.status,
  };
}

export async function checkout(
  idempotencyKey: string,
  items: CheckoutItemInput[],
  logger: FastifyBaseLogger,
): Promise<CheckoutAccepted> {
  const normalizedItems = normalizeCheckoutItems(items);
  const fingerprint = createCheckoutFingerprint(normalizedItems);

  const replay = await existingCheckoutResponse(idempotencyKey, fingerprint);
  if (replay) {
    return replay;
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const productIds = normalizedItems.map((item) => item.productId);
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
      });

      if (products.length !== productIds.length) {
        throw new HttpError(
          404,
          "PRODUCT_NOT_FOUND",
          "One or more products were not found",
        );
      }

      const productsById = new Map(
        products.map((product) => [product.id, product]),
      );

      for (const item of normalizedItems) {
        const updated = await tx.product.updateMany({
          where: {
            id: item.productId,
            stock: { gte: item.quantity },
          },
          data: {
            stock: { decrement: item.quantity },
          },
        });

        if (updated.count !== 1) {
          throw new HttpError(
            409,
            "INSUFFICIENT_STOCK",
            "Estoque insuficiente para um ou mais produtos",
          );
        }
      }

      let total = new Prisma.Decimal(0);
      const orderItems = normalizedItems.map((item) => {
        const product = productsById.get(item.productId);
        if (!product) {
          throw new HttpError(
            404,
            "PRODUCT_NOT_FOUND",
            "One or more products were not found",
          );
        }

        const lineTotal = product.price.mul(item.quantity);
        total = total.add(lineTotal);

        return {
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: product.price,
        };
      });

      const order = await tx.order.create({
        data: {
          idempotencyKey,
          requestFingerprint: fingerprint,
          status: "PENDING",
          total,
          items: {
            create: orderItems,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          orderId: order.id,
          type: OUTBOX_TYPE_PROCESS_ORDER,
          payload: { orderId: order.id },
        },
      });

      return order;
    });

    await invalidateProductsCache(logger);

    return {
      orderId: order.id,
      status: order.status,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const recovered = await existingCheckoutResponse(
        idempotencyKey,
        fingerprint,
      );
      if (recovered) {
        return recovered;
      }
    }

    throw error;
  }
}
