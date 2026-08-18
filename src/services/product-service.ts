import { prisma } from "../lib/prisma.js";

export type PublicProduct = {
  id: string;
  name: string;
  price: string;
  stock: number;
};

export async function listProducts(): Promise<PublicProduct[]> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      price: true,
      stock: true,
    },
    orderBy: {
      name: "asc",
    },
  });

  return products.map((product) => ({
    id: product.id,
    name: product.name,
    price: product.price.toFixed(2),
    stock: product.stock,
  }));
}
