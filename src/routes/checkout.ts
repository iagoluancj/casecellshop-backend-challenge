import type { FastifyInstance } from "fastify";
import { checkoutTotal } from "../observability/metrics.js";
import { checkout } from "../services/checkout-service.js";

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
} as const;

export async function checkoutRoutes(app: FastifyInstance) {
  app.post(
    "/checkout",
    {
      schema: {
        tags: ["Checkout"],
        summary: "Cria um pedido a partir do catálogo local",
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": {
              type: "string",
              minLength: 1,
              description: "Identifica retries da mesma intenção de compra",
            },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["productId", "quantity"],
                properties: {
                  productId: { type: "string", minLength: 1 },
                  quantity: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
        response: {
          202: {
            description:
              "Checkout aceito. Replay da mesma Idempotency-Key devolve o pedido existente, cujo status pode já ter avançado.",
            type: "object",
            additionalProperties: false,
            required: ["orderId", "status"],
            properties: {
              orderId: { type: "string" },
              status: {
                type: "string",
                enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
              },
            },
          },
          400: {
            description: "Request inválida",
            ...errorResponseSchema,
          },
          404: {
            description: "Produto não encontrado",
            ...errorResponseSchema,
          },
          409: {
            description:
              "Estoque insuficiente ou Idempotency-Key reutilizada com payload diferente",
            ...errorResponseSchema,
          },
          500: {
            description: "Erro interno",
            ...errorResponseSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string") {
        request.log.info(
          {
            event: "checkout_failed",
            correlationId: request.correlationId,
            errorCode: "INVALID_REQUEST",
          },
          "Checkout rejected: missing Idempotency-Key",
        );
        checkoutTotal.inc({ result: "error" });
        return reply.status(400).send({
          code: "INVALID_REQUEST",
          message: "Idempotency-Key header is required",
        });
      }

      const body = request.body as {
        items: Array<{ productId: string; quantity: number }>;
      };

      const result = await checkout(
        idempotencyKey,
        body.items,
        request.log,
        request.correlationId,
      );
      return reply.status(202).send(result);
    },
  );
}
