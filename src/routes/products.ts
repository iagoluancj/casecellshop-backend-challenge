import type { FastifyInstance } from "fastify";
import { listProducts } from "../services/product-service.js";

const publicProductSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "price", "stock"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    price: {
      type: "string",
      description: "Valor decimal com duas casas, por exemplo 59.90",
    },
    stock: { type: "integer" },
  },
} as const;

export async function productsRoutes(app: FastifyInstance) {
  app.get(
    "/products",
    {
      schema: {
        tags: ["Products"],
        summary: "Lista os produtos disponíveis no catálogo",
        response: {
          200: {
            description: "Lista de produtos da vitrine",
            type: "array",
            items: publicProductSchema,
          },
        },
      },
    },
    async () => {
      return listProducts();
    },
  );
}
