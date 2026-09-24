# Mekong — KHQR mock store

A Next.js 16 mock storefront for creating dynamic **Bakong KHQR** payments and experimenting with **webhook callbacks** or **MD5 polling**.

## Run locally

Requires **Node.js 22.13+** and **pnpm**. Transactions use Node's built-in SQLite driver.

```bash
pnpm install
pnpm dev
```

Open **http://localhost:3000**. No credentials are required in the default `mock` environment.

1. Add products to your bag and select USD or KHR.
2. Choose **Polling** or **Webhook** under **Your integration**.
3. Select **Checkout with KHQR** to generate the QR and its MD5.
4. Use **Simulate successful payment** or **Simulate a failed payment** in checkout.
5. Open **Transactions** to view orders, reopen a checkout, or search an MD5.

The QR is generated and verified with `bakong-khqr`, the JavaScript SDK referenced by NBC. Mock QR codes always use the demo account `mock_store@devb`; the simulator completes these payments without a banking app.

## Edit product prices

Click **Edit price** on any product, choose **USD** or **KHR**, enter the new amount, and select **Save price**. The bag switches to the selected currency and recalculates its total, including products already added.

- USD supports positive prices with up to two decimal places, starting at **$0.01** (maximum $1,000,000).
- KHR supports positive whole-riel prices, starting at **៛1** (maximum 1,000,000,000 riel).
- Each product has independent USD and KHR prices. Saving edits the selected currency's price; there is no automatic exchange-rate conversion.
- Saved prices are shared by this mock store and persist in SQLite across reloads and server restarts. Your browser remembers its selected checkout currency.
- Each generated checkout keeps a snapshot of its prices. New checkouts use the latest saved catalog. If another client changes a price while your bag is open, checkout refreshes the prices and asks you to review the updated total.

## Webhook or polling?

| Method | How it works |
| --- | --- |
| **Polling** | The browser calls this app's search endpoint every 3 seconds. In Bakong mode, the server sends `POST /v1/check_transaction_by_md5` with a server-side Bearer token. In mock mode, it reads the simulated provider result. |
| **Webhook** | A payment gateway posts a status to `/api/v1/transactions/callback`. Checkout receives local status changes over a server-sent event stream, without repeatedly querying Bakong. In Bakong mode, a successful callback triggers an independent Bakong verification. |

**Bakong's linked public integration guide specifies MD5 polling, not a generic webhook subscription.** This app's callback body and `x-webhook-secret` header are an application-specific contract. For actual webhook delivery, configure a compatible gateway/adapter to call this app's publicly reachable callback URL. There is no automatic webhook registration with NBC. Deep-link return URLs are not payment webhooks.

You can switch the active checkout listener between the two methods. **Check MD5 now** explicitly queries the provider regardless of the listener selection. The method stored with an order records the choice at creation.

In mock polling mode, the simulator records a provider outcome; only a later MD5 poll settles the order. In mock webhook mode, the simulator invokes the exact callback handler, including its validation and authentication. It does not send an external network request to itself.

## Environment configuration

Copy `.env.example` to `.env.local` and restart the server after changing configuration.

| Variable | Default / purpose |
| --- | --- |
| `PAYMENT_MODE` | `mock` or `bakong`; default `mock` |
| `DATABASE_PATH` | `.data/khqr.sqlite` |
| `KHQR_MERCHANT_NAME` | `Mekong Store`; ASCII, maximum 25 characters |
| `KHQR_MERCHANT_CITY` | `Phnom Penh`; ASCII, maximum 15 characters |
| `KHQR_EXPIRATION_MINUTES` | `5`; integer from 1 to 10, following the integration guide's maximum payment window |
| `BAKONG_ACCOUNT_ID` | Receiving account, required in Bakong mode |
| `BAKONG_TOKEN` | Bakong Open API access token, required in Bakong mode |
| `BAKONG_API_URL` | `https://api-bakong.nbc.gov.kh`; base URL **without** `/v1` |
| `KHQR_MERCHANT_ID` | Optional; switches SDK generation from individual to merchant KHQR |
| `KHQR_ACQUIRING_BANK` | Required when a merchant ID is supplied |
| `WEBHOOK_SECRET` | Shared callback secret; optional in mock mode, required to enable webhook mode with Bakong |

### Connect Bakong

1. Register for an access token through the [Bakong Open API portal](https://api-bakong.nbc.gov.kh/) or the [SIT portal](https://sit-api-bakong.nbc.org.kh/).
2. Set `PAYMENT_MODE=bakong`, `BAKONG_ACCOUNT_ID`, `BAKONG_TOKEN`, and the appropriate environment's `BAKONG_API_URL`.
3. Choose **Polling** for the directly documented Bakong integration.
4. For a gateway-based webhook integration, set `WEBHOOK_SECRET` and register `https://your-host/api/v1/transactions/callback` with that gateway. Its adapter must translate the payload to the contract below; `transactionId` must be Bakong's transaction `hash`.

Tokens remain on the server. In Bakong mode the simulator returns 404. The health check tests local configuration and SQLite access; it does not claim to test token validity or Bakong connectivity.

## API

All responses are JSON except the SSE endpoint. Transaction responses use `{ "data": { ... } }`; errors use `{ "error": "..." }` with a suitable HTTP status. Dynamic responses are not cached. Transaction amounts always come from the server-side product catalog.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health-check` | Configuration/storage readiness, environment, supported update methods; 200 or 503 |
| `GET` | `/api/v1/products` | Catalog with saved USD/KHR prices |
| `PATCH` | `/api/v1/products/<productId>` | Save a product's price for the specified currency |
| `POST` | `/api/v1/transactions` | Create an order and KHQR; returns 201 |
| `GET` | `/api/v1/transactions` | Most recent 30 orders in the current environment |
| `POST` | `/api/v1/transactions/callback` | Receive a payment outcome |
| `GET` | `/api/v1/transactions/search?md5=<md5>&method=polling` | Check the provider and return the transaction (`polling` is the default) |
| `GET` | `/api/v1/transactions/search?md5=<md5>&method=webhook` | Read locally recorded callback status without contacting Bakong |
| `GET` | `/api/v1/transactions/events?md5=<md5>` | SSE events named `transaction` containing the transaction object |
| `POST` | `/api/v1/transactions/simulate` | Mock-only provider/callback simulation |

### Update a product price

```bash
curl -X PATCH http://localhost:3000/api/v1/products/mondulkiri-coffee \
  -H 'Content-Type: application/json' \
  -d '{"currency":"USD","price":0.25}'
```

Returns `{ "data": { ...product, "price": { "USD": 0.25, "KHR": 34000 } } }` for the initial catalog. Use `"currency":"KHR"` and a whole-number `price` to edit the riel price. Invalid prices/currencies return 400; unknown products return 404. These shared mock-store editing endpoints are available from the storefront and API without a separate account.

### Create KHQR

```bash
curl -X POST http://localhost:3000/api/v1/transactions \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"mondulkiri-coffee","quantity":1}],"currency":"USD","method":"webhook"}'
```

Other product IDs: `everyday-cup`, `market-tote`, `daily-notes`, `quiet-candle`, `daily-bottle`. Quantities must be integers from 1–20; each product can appear once. Currencies are `USD` and `KHR`.

The response contains `orderNumber`, `md5`, the original `qr` string, a PNG `qrImage` data URL, server-calculated `amount`, `currency`, `expiresAt`, `status`, and an activity log. Every order has a unique reference embedded in its dynamic KHQR.

Optionally send `expectedAmount` with the displayed cart total. The server returns 409 if it differs from the current catalog total. The storefront uses this check and refreshes the catalog on an unsuccessful checkout.

### Receive a successful callback

Replace `MD5_FROM_CHECKOUT` with the returned 32-character MD5 and use the checkout's returned amount, currency, and account. This example matches one coffee order at its original mock price.

```bash
curl -X POST http://localhost:3000/api/v1/transactions/callback \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: YOUR_CONFIGURED_SECRET' \
  -d '{
    "md5":"MD5_FROM_CHECKOUT",
    "status":"paid",
    "amount":8.5,
    "currency":"USD",
    "toAccountId":"mock_store@devb",
    "transactionId":"mock-payment-001"
  }'
```

Omit the secret header only when `WEBHOOK_SECRET` is empty in mock mode. For a failed payment the body is `{ "md5": "MD5_FROM_CHECKOUT", "status": "failed" }`.

Callbacks validate the MD5, amount, currency, and recipient. Matching duplicate deliveries return 200 without adding duplicate events. Conflicting outcomes return 409 and cannot overwrite a settled payment. Malformed input returns 400, invalid credentials 401, unsupported content type 415, and an unknown MD5 404. A successful Bakong-mode callback is checked against Bakong before settlement; a not-yet-confirmed transfer returns 409 so the gateway can retry.

### Poll by MD5

```bash
curl 'http://localhost:3000/api/v1/transactions/search?md5=MD5_FROM_CHECKOUT&method=polling'
```

Statuses: `pending`, `paid`, `failed`, `expired`. Bakong's “transaction could not be found” response means `pending` until expiry. Provider authentication, network, and malformed-response errors are surfaced as 502 instead of being reported as a failed payment. Calls are coalesced in flight and successful checks are throttled to one per 3 seconds per transaction in a server process.

An expired payment may still be reconciled as paid by a verified late callback or explicit MD5 check. Expiry closes the payment window; it does not prove that funds were never transferred.

### Simulate a payment

```bash
curl -X POST http://localhost:3000/api/v1/transactions/simulate \
  -H 'Content-Type: application/json' \
  -d '{"md5":"MD5_FROM_CHECKOUT","status":"paid","method":"polling"}'
```

The next MD5 poll discovers this result. Use `"method":"webhook"` to exercise callback processing instead. This endpoint is only available for pending mock orders.

## Storage and deployment

Orders, product price overrides, and mock provider outcomes persist in SQLite at `DATABASE_PATH`, including across restarts. Product prices are stored in integer minor units (USD cents or whole riel). Writes use transactions so concurrent callback and polling requests cannot partially update an order. The SSE endpoint reads that same database, sends changed statuses, and closes after 55 seconds for automatic browser reconnection; it never polls Bakong.

Run with `pnpm build && pnpm start` on a **Node server with persistent writable storage**. This is a shared mock storefront: the order list is not scoped to user accounts. For multi-instance/serverless deployment, replace local SQLite with shared durable storage and add the access controls appropriate to the application.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

API tests use an isolated temporary database and test SDK output, editable price persistence/validation, stale cart detection, callback authentication/idempotency, amount mismatches, expiry reconciliation, MD5 polling, streaming, and mocked Bakong verification. Browser tests build the app and start a separate production-mode mock server on port 3197 (override with `E2E_PORT`) with their own SQLite database. They cover both status methods, failed payments, MD5 lookup, mobile KHR checkout, and price edits through to checkout and reload. No real Bakong transfer is required for these tests.

## Bakong references consulted

- [NBC Bakong website and KHQR downloads](https://bakong.nbc.gov.kh/)
- [QR Payment Integration — v1.0.3](https://bakong.nbc.gov.kh/download/KHQR/integration/QR%20Payment%20Integration.pdf): dynamic QR flow, 10-minute maximum window, Bearer authentication, MD5 status API, and response examples.
- [KHQR SDK Document](https://bakong.nbc.gov.kh/download/KHQR/integration/KHQR%20SDK%20Document.pdf): JavaScript individual/merchant KHQR generation and verification.
- [`bakong-khqr` JavaScript SDK](https://www.npmjs.com/package/bakong-khqr): current dynamic QR expiration parameter and SDK usage.
- [Bakong Open API](https://api-bakong.nbc.gov.kh/)
