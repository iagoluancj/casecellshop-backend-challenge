# Arquitetura — CaseCellShop Backend

## Visão geral

O ERP legado permanece responsável por estoque, faturamento e demais rotinas da empresa, e não é alterado. O backend da loja reduz o acoplamento síncrono com esse sistema: a API não espera o ERP para aceitar um pedido.

Catálogo e checkout têm caminhos distintos. O catálogo lê uma projeção local (Read Model) atrás de cache. O checkout persiste o comando no banco da aplicação e encaminha a operação com o ERP para processamento assíncrono.

## Arquitetura geral

```mermaid
flowchart TB
  subgraph erpBox["ERP"]
    ERP[(ERP<br/>MySQL, simulado no desafio)]
  end

  subgraph loja["Backend da loja — um único sistema"]
    RM[(Product local)]
    Cache[Cache]
    API[API Fastify]

    Order[(Order)]
    Outbox[(OutboxEvent)]
    Publisher[Outbox Publisher]
    Queue[Fila]
    Worker[Worker]
    Reconciler[Order Reconciler]
  end

  subgraph obs["Observabilidade — transversal"]
    Logs[Logs estruturados]
    Ids[requestId / correlationId / orderId]
    Metrics[Métricas: cache, checkout, fila/worker, ERP, latência, retries, FAILED]
  end

  RM --> Cache
  Cache --> API
  RM --> API

  API -->|GET /products| Cache
  API -->|POST /checkout<br/>transação no nosso banco| Order
  API --> Outbox
  Order --- Outbox

  Outbox --> Publisher
  Publisher --> Queue
  Queue --> Worker
  Worker -->|operação de negócio| ERP
  Worker -->|atualiza status| Order
  Reconciler -->|PROCESSING stale| Order
  Reconciler -->|consulta status| ERP
  API -->|GET /orders/:orderId/status| Order

  Logs -.-> API
  Logs -.-> Publisher
  Logs -.-> Worker
  Logs -.-> Reconciler
  Ids -.-> API
  Ids -.-> Worker
  Metrics -.-> Cache
  Metrics -.-> API
  Metrics -.-> Queue
  Metrics -.-> Worker
  Metrics -.-> Reconciler
  Metrics -.-> ERP
```

## Catálogo

`GET /products` consulta o cache primeiro. Em miss, a API lê a tabela local `Product` — um read model **simulado**. Neste desafio não há sincronização automática com um MySQL de ERP: o catálogo entra pelo seed. O estoque da vitrine não é garantia para o checkout.

```mermaid
flowchart LR
  RM[(Product local)]
  Cache[Cache]
  API[API]
  Client[Cliente]

  RM --> Cache --> API --> Client

  Client -->|GET /products| API
  API -->|miss| RM
```

## Checkout assíncrono

```
POST /checkout
→ validação
→ idempotência
→ controle concorrente de estoque
→ transação Order + OutboxEvent
→ 202 Accepted
→ fila
→ worker
→ ERP
→ atualização do status
```

`Order` e `OutboxEvent` são gravados na mesma transação no banco da aplicação. O ERP não participa dessa transação. Depois do `202 Accepted`, o Outbox Publisher publica o evento, o worker consome a fila, chama a integração com o ERP e atualiza o pedido.

Status do pedido: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`.

O status é consultado em `GET /orders/:orderId/status`.

O Order Reconciler (polling interno, uma instância, ciclo de vida em `server.ts`) detecta `PROCESSING` com `updatedAt` acima de `ORDER_RECONCILIATION_STALE_MS` e consulta o ERP Fake. Não há endpoint HTTP. Várias instâncias exigiriam claim/lock/leader election — fora do escopo.

```mermaid
sequenceDiagram
  actor Cliente
  participant API
  participant DB as Nosso banco
  participant Pub as Outbox Publisher
  participant Fila
  participant Worker
  participant ERP as ERP

  Cliente->>API: POST /checkout
  API->>API: validação
  API->>API: idempotência
  API->>API: controle concorrente / reserva de estoque
  API->>DB: transação: Order + OutboxEvent
  API-->>Cliente: 202 Accepted

  Note over Pub,Worker: a partir daqui, assíncrono

  Pub->>DB: lê OutboxEvent
  Pub->>Fila: publica
  Fila->>Worker: consome
  Worker->>ERP: operação de negócio
  Worker->>DB: atualiza status do Order

  Cliente->>API: GET /orders/:orderId/status
  API->>DB: consulta Order
  API-->>Cliente: status
```

## Observabilidade

Instrumentação atual: `docs/OBSERVABILITY.md`.

- logs estruturados
- `requestId` / `correlationId`
- métricas de cache
- métricas de checkout
- fila e worker
- latência e falhas da integração com o ERP
- `GET /metrics` (Prometheus)
- reconciliação de `PROCESSING` stale

## Decisões técnicas

- cache Redis cache-aside; fallback para PostgreSQL se o Redis falhar
- fila BullMQ no Redis (mesma instância do cache, responsabilidades distintas)
- estoque com `UPDATE ... WHERE stock >= quantity` na transação do checkout
- `Product` local/seed; sem sync com ERP MySQL
- sem tracing/OpenTelemetry neste recorte
- Docker Compose para avaliação: um processo `api` + `postgres` + `redis` (`docs/DOCKER.md`)
