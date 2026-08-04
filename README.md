# zakupki-gateway

Единая точка взаимодействия с пользователем:

- Web UI (каталог, CSV-ingest, статусы, AI-анализ)
- HTTP API proxy → `zakupki-core`
- enrichment (`/courts`, `/rnp`, …) → `zakupki-customer` (когда задан `CUSTOMER_URL`)
- задел под Telegram / Slack (каналы уведомлений — следующий этап)

## Env

| Переменная | По умолчанию |
|------------|--------------|
| `HTTP_ADDR` | `:3000` |
| `CORE_URL` | `http://127.0.0.1:8080` |
| `CUSTOMER_URL` | _(пусто)_ |
| `UI_DIR` | `ui` |

```bash
export CORE_URL=http://127.0.0.1:8080
go run ./cmd/gateway
# UI http://localhost:3000
```

Полный стек: [zakupki-platform](https://github.com/rinat1313/zakupki-platform).
