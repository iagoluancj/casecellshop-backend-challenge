# Observabilidade — CaseCellShop Backend

Instrumentação local: logs estruturados (Pino/Fastify), `requestId`, `correlationId` e métricas Prometheus via `prom-client`. Sem Datadog, Grafana, Prometheus Server ou OpenTelemetry nesta etapa.

`GET /metrics` é operacional. Em produção o endpoint deve ficar restrito por rede ou autenticação; o desafio não exige auth.

## Sinais

| Área | Logs (`event`) | Métricas |
| --- | --- | --- |
| HTTP | `http_request_completed` | `casecellshop_http_request_duration_seconds` |
| Cache | `products_cache_hit/miss/error` | `casecellshop_cache_hits_total`, `misses_total`, `errors_total` |
| Checkout | `checkout_received/accepted/insufficient_stock/idempotent_replay/failed` | `casecellshop_checkout_total{result}` |
| Outbox | `outbox_publish_started/published/failed` | `casecellshop_outbox_published_total`, `outbox_publish_failures_total` |
| Worker | `order_processing_started/completed/retry/failed` | `casecellshop_worker_jobs_total{result}`, `worker_retries_total`, `worker_processing_duration_seconds` |
| ERP | `erp_request_started/completed/timeout/error` | `casecellshop_erp_requests_total{result}`, `erp_request_duration_seconds` |
| Compensação | `stock_compensation_completed/skipped` | `casecellshop_stock_compensations_total` |
| Estado atual | — | `casecellshop_queue_waiting_jobs`, `orders_pending`, `orders_processing` |

`requestId` identifica uma requisição HTTP (`request.id` do Fastify). `correlationId` identifica a jornada de negócio e segue `POST /checkout` → Outbox payload → job BullMQ → Worker → ERP.

Identificadores (`orderId`, `productId`, `requestId`, `correlationId`) ficam nos **logs**. Labels de métrica são conjuntos pequenos (`method`, `route`, `status_code`, `result`).

Hit ratio de cache não é métrica própria: `hits / (hits + misses)` no scraper. P50/P95/P99 não são calculados na aplicação; saem dos buckets do Histogram.

Gauges de fila e de Orders usam `collect()` no scrape: `/metrics` consulta BullMQ e PostgreSQL. Trade-off: o scrape deixa de ser puramente in-memory e pode atrasar se Redis/Postgres estiverem lentos; em troca o valor reflete o estado real após restart.

`/metrics` e `/docs` ficam fora do histogram HTTP. `/metrics` é o próprio scrape. `/docs` é UI/estáticos, não SLI de negócio. `/metrics` também está oculto no Swagger da API pública.

Métricas `casecellshop_process_*` vêm de `collectDefaultMetrics()` (CPU/processo, memória, event loop, GC conforme a plataforma).

## SLI / SLO

Hipóteses iniciais para validação com tráfego real — não são SLA da empresa.

| SLI | Como ler | SLO proposto (baseline) |
| --- | --- | --- |
| Disponibilidade `GET /products` | `1 - rate(5xx)/rate(requests)` na rota | ≥ 99.5% em 30d |
| Latência `GET /products` | P95 de `http_request_duration_seconds` | P95 < 200 ms em janela de 5 min |
| Checkout aceito vs erro | `checkout_total{result}` | `error` < 1% dos checkouts em 1h, excluindo `insufficient_stock` |
| ERP timeout | `erp_requests_total{result="timeout"} / erp_requests_total` | < 2% em 15 min |
| Tempo do worker | P95 de `worker_processing_duration_seconds` | P95 < 2 s em 15 min (timeout ERP local = 1 s) |
| Fila | `queue_waiting_jobs` | não crescer de forma contínua por 10 min |

## Alertas (conceituais)

Poucos, com janela sustentada — não implementar Alertmanager nesta etapa.

1. Taxa de HTTP 5xx elevada por 5 min.
2. P95 de `GET /products` acima do baseline por 10 min.
3. Taxa de `erp_timeout` elevada por 10 min.
4. `queue_waiting_jobs` subindo de forma contínua.
5. `orders_processing` alto por tempo incompatível com o timeout/retry configurado.
6. Aumento de `worker_jobs_total{result="failed"}`.
7. Hit ratio de cache caindo de forma sustentada (`hits/(hits+misses)`).

## Dashboard conceitual

```
PAINEL API
- request rate (histogram count)
- error rate (status_code 5xx)
- P95 / P99 (histogram)

PAINEL CACHE
- hits / misses
- hit ratio
- Redis errors

PAINEL CHECKOUT
- accepted
- insufficient_stock
- idempotent_replay
- error

PAINEL ASSÍNCRONO
- queue depth (gauge)
- worker completed / failed
- retries
- orders PENDING / PROCESSING

PAINEL ERP
- request rate
- success / timeout / error
- latency (histogram)
```

## Evolução: tracing

Não há OpenTelemetry nesta etapa. Evolução natural:

```
POST /checkout
├─ idempotency
├─ stock reservation
├─ transaction
└─ outbox

Worker
└─ ERP integration
```

`correlationId` já amarra os logs dessa jornada.
