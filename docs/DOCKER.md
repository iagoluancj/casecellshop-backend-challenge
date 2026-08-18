# Docker (avaliação)

```sh
docker compose up --build
```

Sobe `postgres`, `redis` e `api`. Outbox Publisher, Worker e Reconciler continuam no mesmo processo da API — não há containers extras para eles.

A API fica em `http://localhost:3000` (`/health`, `/docs`, `/metrics`, `/products`, `/checkout`, `/orders/:orderId/status`).

No container da API: `prisma migrate deploy` → seed idempotente → `node dist/server.js`. O seed não cria Orders e não reseta estoque de produtos já existentes.

PostgreSQL e Redis não são publicados no host, para não conflitar com `pnpm dev` local.

## Sem Docker

`pnpm dev` continua válido com PostgreSQL e Redis locais (`.env.example` usa `localhost`).

## Testes

`docker compose up` **não** executa a suíte. Localmente:

```sh
pnpm test
```

Requer o banco `casecellshop_test` em `DATABASE_URL_TEST` (nunca o banco de desenvolvimento).

## Volumes

- `docker compose down` — para os containers e **preserva** dados (Postgres e Redis AOF).
- `docker compose down -v` — também apaga os volumes; a próxima subida é um ambiente limpo.
