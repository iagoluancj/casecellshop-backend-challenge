import Fastify, { type FastifyServerOptions } from "fastify";
import swaggerPlugin from "./plugins/swagger.js";
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

  return app;
}
