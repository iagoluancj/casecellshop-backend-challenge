import { prisma } from "../src/lib/prisma.js";

const products = [
  {
    externalId: "erp-capinha-iphone-15",
    name: "Capinha iPhone 15",
    price: "59.90",
    stock: 10,
  },
  {
    externalId: "erp-capinha-galaxy-s24",
    name: "Capinha Galaxy S24",
    price: "54.90",
    stock: 8,
  },
  {
    externalId: "erp-capinha-moto-g84",
    name: "Capinha Moto G84",
    price: "39.90",
    stock: 15,
  },
  {
    externalId: "erp-capinha-redmi-note-13",
    name: "Capinha Redmi Note 13",
    price: "34.90",
    stock: 12,
  },
  {
    externalId: "erp-capinha-iphone-14",
    name: "Capinha iPhone 14",
    price: "49.90",
    stock: 6,
  },
];

async function seed() {
  for (const product of products) {
    await prisma.product.upsert({
      where: { externalId: product.externalId },
      create: product,
      update: {
        name: product.name,
        price: product.price,
        stock: product.stock,
      },
    });
  }
}

try {
  await seed();
  console.log(`Seed concluído: ${products.length} produtos.`);
} finally {
  await prisma.$disconnect();
}
