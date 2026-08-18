import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

async function swaggerPlugin(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "CaseCellShop Backend API",
        description: "Backend do desafio técnico CaseCellShop.",
        version: "0.1.0",
      },
      tags: [{ name: "Health" }, { name: "Products" }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });
}

export default fp(swaggerPlugin);
