import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import { HttpError } from "./http-error.js";
import { closeRedis, connectRedis } from "./lib/redis.js";
import { checkoutTotal } from "./observability/metrics.js";
import observabilityPlugin from "./plugins/observability.js";
import swaggerPlugin from "./plugins/swagger.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { healthRoutes } from "./routes/health.js";
import { metricsRoutes } from "./routes/metrics.js";
import { ordersRoutes } from "./routes/orders.js";
import { productsRoutes } from "./routes/products.js";

export async function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            requestId: request.id,
          };
        },
        res(reply) {
          return {
            statusCode: reply.statusCode,
          };
        },
      },
    },
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId",
    }),
    ...options,
  });

  await app.register(observabilityPlugin);
  await app.register(swaggerPlugin);
  await app.register(healthRoutes);
  await app.register(productsRoutes);
  await app.register(checkoutRoutes);
  await app.register(ordersRoutes);
  await app.register(metricsRoutes);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof Error && "validation" in error) {
      if (request.url.split("?")[0] === "/checkout") {
        request.log.info(
          {
            event: "checkout_failed",
            correlationId: request.correlationId,
            errorCode: "INVALID_REQUEST",
          },
          "Checkout rejected: invalid request",
        );
        checkoutTotal.inc({ result: "error" });
      }
      return reply.status(400).send({
        code: "INVALID_REQUEST",
        message: error.message,
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
  });

  app.addHook("onReady", async () => {
    await connectRedis(app.log);
  });

  app.addHook("onClose", async () => {
    await closeRedis();
  });

  return app;
}
