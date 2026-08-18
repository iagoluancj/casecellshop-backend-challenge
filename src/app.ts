import Fastify, { type FastifyServerOptions } from "fastify";
import { HttpError } from "./http-error.js";
import { closeRedis, connectRedis } from "./lib/redis.js";
import swaggerPlugin from "./plugins/swagger.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { healthRoutes } from "./routes/health.js";
import { productsRoutes } from "./routes/products.js";

export async function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: true,
    ...options,
  });

  await app.register(swaggerPlugin);
  await app.register(healthRoutes);
  await app.register(productsRoutes);
  await app.register(checkoutRoutes);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof Error && "validation" in error) {
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
