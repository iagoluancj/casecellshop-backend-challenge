# Uso de IA

Ferramentas de IA foram usadas como apoio para estudar alternativas, gerar código e auditar o repositório. O comportamento entregue foi conferido no código e em `pnpm test` / Compose.

Os prompts abaixo foram **resumidos**. Não são transcrição literal de toda a conversa. Ficaram só as interações que mudaram arquitetura, implementação, testes ou o que a documentação pode afirmar.

## Arquitetura

Prompt:

> Separar catálogo (leitura) de checkout (comando). A API não espera o ERP. Product como read model local. Um único backend, sem microsserviços. Documentar o recorte em `docs/ARCHITECTURE.md`.

Objetivo: definir os dois fluxos e o tamanho da solução.

Decisão resultante: `GET /products` lê `Product` + Redis; `POST /checkout` grava `Order` + outbox e devolve `202`. Worker fala com o ERP Fake depois. Sem sync real com MySQL.

## Concorrência e idempotência

Prompt:

> Impedir venda além do estoque. Comparar update atômico, lock pessimista, reserva e distributed lock. Idempotency-Key para retry, duplo clique e duas requests simultâneas com a mesma chave. Preço vem do banco.

Objetivo: escolher um mecanismo defensável e pequeno.

Decisão: `updateMany` com `stock >= quantity` na transação PostgreSQL. Sem distributed lock. `idempotencyKey` UNIQUE + fingerprint dos itens. Durante a auditoria encontrei que, com duas requests concorrentes usando a mesma idempotency key e apenas uma unidade em estoque, a ordem das operações poderia fazer o segundo request receber estoque insuficiente em vez de replay. Como tudo estava dentro da transação, alterei a ordem para a constraint UNIQUE da Order decidir primeiro qual request vence.

## Transactional Outbox

Prompt:

> Order e OutboxEvent na mesma transação. Publisher periódico, não na request HTTP. jobId determinístico. Não afirmar exactly-once.

Objetivo: tratar dual write banco vs fila.

Decisão: polling do publisher → BullMQ com `jobId = outboxEvent.id` → `PUBLISHED`. Falha deixa `PENDING`. Semântica at-least-once; worker e ERP Fake idempotentes no processo.

## Cache

Prompt:

> Cache-aside no Redis para `GET /products`, TTL, fallback se o Redis cair, invalidação depois de mudar estoque. Single-flight só no processo, se existir.

Objetivo: catálogo rápido sem mentir sobre consistência nem sobre lock distribuído.

Decisão: chave `products:list`, TTL configurável, `DEL` após checkout/compensação, fallback PostgreSQL, `inflightListProducts` por instância Node. Cliente `redis` para cache; `ioredis` para BullMQ.

## Processamento assíncrono e ERP Fake

Prompt:

> Worker fora do HTTP. Retry, backoff, timeout. COMPLETED depois do sucesso. FAILED só na última tentativa. Compensar estoque uma vez. ERP Fake determinístico nos testes.

Objetivo: simular integração sem ERP real.

Decisão: BullMQ no mesmo processo (`src/server.ts`). `FakeErp` em memória (`processedOrderIds`). `stockReleasedAt` na compensação. Timeout com `AbortController`.

## Reconciliação

Prompt:

> Detectar `PROCESSING` stale, perguntar ao ERP Fake (`COMPLETED` / `NOT_FOUND`), sem distributed lock e sem endpoint HTTP. Uma instância.

Objetivo: não assumir que a fila/worker nunca falham.

Decisão: reconciliador com `setInterval` no `server.ts`. COMPLETED alinha o Order; NOT_FOUND volta a PENDING e republica outbox. Set do ERP some no restart — limitação documentada.

## Observabilidade

Prompt:

> Logs estruturados, requestId, correlationId, orderId. Poucas métricas Counter/Gauge/Histogram, sem labels de alta cardinalidade. `GET /metrics`. Dashboard/alertas conceituais, sem Datadog/OTel.

Objetivo: instrumentar o que o código controla.

Decisão: Pino, `x-correlation-id`, `prom-client`, gauges via `collect()` no scrape. Contrato de sinais em `docs/OBSERVABILITY.md`.

## Docker

Prompt:

> `docker compose up --build` com `api`, `postgres` e `redis`. Publisher/worker/reconciler no mesmo container. `migrate deploy` + seed idempotente. Sem microsserviços extras.

Objetivo: avaliação reproduzível.

Decisão: `compose.yaml`, `Dockerfile` Node 24, entrypoint `migrate deploy` → seed → `node dist/server.js`. URLs internas `postgres` e `redis`.

## Testes / Auditoria

Prompt:

> Auditar o checkout (transação, estoque, idempotência, outbox). Não afirmar exactly-once nem sync com ERP. 

Objetivo: o README só descrever o que o código faz.

Decisão: auditoria apontou Order antes do estoque na transação, `COMPLETED` sem sobrescrever `FAILED`, heartbeat de `PROCESSING` no retry, e a doc de arquitetura sem seta ERP→sync. Suíte em PostgreSQL real (`casecellshop_test`).