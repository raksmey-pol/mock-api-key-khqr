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
2. Choose **Polling** or **Webhook** under **Your integration**. For webhooks, choose **Signed**, **Token**, or **Unsigned** before creating checkout.
3. Select **Checkout with KHQR**, or open **Your integration** settings and turn **Checkout page** on first to pay through the hosted page, embedded or as a full-page redirect.
4. Use **Simulate successful payment** or **Simulate a failed payment** in checkout. When the checkout page is on, its demo controls simulate the session settlement instead.
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

| Method      | How it works                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Polling** | The browser calls this app's search endpoint every 3 seconds. In Bakong mode, the server sends `POST /v1/check_transaction_by_md5` with a server-side API key in the `x-api-key` header. In mock mode, it reads the simulated provider result.    |
| **Webhook** | A payment gateway posts a status to `/api/v1/transactions/callback`. Checkout receives local status changes over a server-sent event stream. Webhook mode uses only the selected webhook authentication mode and does not call Bakong's Open API. |

**Bakong's linked public integration guide specifies MD5 polling, not a generic webhook subscription.** This app accepts both the provider's `requestId` + `transactions[]` batch envelope and a compact single-transaction callback. For actual webhook delivery, configure the provider to call this app's publicly reachable callback URL. There is no automatic webhook registration with NBC. Deep-link return URLs are not payment webhooks.

You can switch the active checkout listener between the two methods. **Check MD5 now** explicitly queries the provider regardless of the listener selection. The method stored with an order records the choice at creation.

In mock polling mode, the simulator records a provider outcome; only a later MD5 poll settles the order. In mock webhook mode, the simulator invokes the exact callback handler, including its validation and authentication. It does not send an external network request to itself.

### Webhook authentication modes

Under **Your integration → Webhook**, select one of three modes:

| Mode         | Callback requirements                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Signed**   | HMAC-SHA256 signature over the exact body bytes plus a timestamp. Requires `WEBHOOK_SECRET` on the server. |
| **Token**    | Send `WEBHOOK_SECRET` in the `x-webhook-secret` header. The body is not signed.                            |
| **Unsigned** | Plain JSON callback with `Content-Type: application/json`. No authentication header is required.           |

The selected `webhookSignatureMode` is stored with each transaction. The receiver enforces that saved policy for all callbacks to the order, including after switching its UI listener between polling and webhook. A callback cannot change the saved mode through a header, query parameter, or body field. Your browser remembers the selection for new checkouts.

The simulator follows the saved mode: it signs signed callbacks, adds the token header for token callbacks, and sends plain JSON for unsigned callbacks. The key stays on the server. Every mode still validates the MD5, amount, currency, recipient, and final status.

Webhook settlement does **not** call Bakong's Open API and does not require `BAKONG_TOKEN`. `BAKONG_TOKEN` is used only when you select **Polling** in Bakong mode. If it is absent or rejected, webhook checkout remains available while polling is disabled or returns a configuration error.

To enable **Signed** or **Token**, set `WEBHOOK_SECRET` in `.env.local` and restart the server. The default for new orders is signed when a key is configured, otherwise unsigned. `WEBHOOK_SIGNATURE_MODE` accepts `signed`, `token`, or `unsigned`; the UI and create-order API can override it per order. Health responses list available webhook modes without exposing the key.

Existing orders created before this feature retain their original `x-webhook-secret` authentication when a secret is configured. Newly created orders always include `webhookSignatureMode`.

## Environment configuration

Copy `.env.example` to `.env.local` and restart the server after changing configuration.

| Variable                  | Default / purpose                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_MODE`            | `mock` or `bakong`; default `mock`                                                                                                                        |
| `DATABASE_PATH`           | `.data/khqr.sqlite`                                                                                                                                       |
| `KHQR_MERCHANT_NAME`      | `Mekong Store`; ASCII, maximum 25 characters                                                                                                              |
| `KHQR_MERCHANT_CITY`      | `Phnom Penh`; ASCII, maximum 15 characters                                                                                                                |
| `KHQR_EXPIRATION_MINUTES` | `5`; integer from 1 to 10, following the integration guide's maximum payment window                                                                       |
| `BAKONG_ACCOUNT_ID`       | Receiving account, required in Bakong mode                                                                                                                |
| `BAKONG_TOKEN`            | Bakong Open API key, sent as the `x-api-key` header; required only for Bakong MD5 polling, not webhook mode                                               |
| `BAKONG_API_URL`          | `https://api-bakong.nbc.gov.kh`; base URL **without** `/v1`                                                                                               |
| `KHQR_MERCHANT_ID`        | Optional; switches SDK generation from individual to merchant KHQR                                                                                        |
| `KHQR_ACQUIRING_BANK`     | Required when a merchant ID is supplied                                                                                                                   |
| `WEBHOOK_SECRET`          | HMAC-SHA256 signing key; required for signed callbacks, optional for unsigned callbacks                                                                   |
| `WEBHOOK_SIGNATURE_MODE`  | Default for new orders: `signed`, `token`, or `unsigned`. If empty, defaults to signed when a key is set, otherwise unsigned. Signed/token require a key. |
| `BAKONG_MERCHANT_TOKEN`   | Merchant bearer token for the Bakong checkout page; set together with `BAKONG_CHECKOUT_API_URL` to enable the checkout page                                |
| `BAKONG_CHECKOUT_API_URL` | Checkout page Open API base URL **without** `/v1` (for example `https://checkout.bakong.nbc.gov.kh`); enabling both also enables the merchant endpoints    |

### Connect the hosted checkout page

Store settings can route enquiry through the hosted Bakong checkout page instead of the inline KHQR, either embedded in the store or as a full-page redirect.

1. With both `BAKONG_MERCHANT_TOKEN` and `BAKONG_CHECKOUT_API_URL` unset (default), the demo emulates the page: it mints local sessions, serves a First-party browser endpoint, and settles from the page's demo controls. In this mode the switch works end to end without real credentials.
2. With both variables set, the storefront mints `POST /v1/checkout/sessions` against the real Bakong checkout Open API with the merchant token and a UUID `Idempotency-Key`, and returns its `checkout_url`, `session_id`, and `md5`. Orders settle only after the merchant backend long-polls and verifies the session (section 6 and 7.2 of the checkout integration guide); the browser page and its messages are never trusted alone.
3. One variable without the other is a configuration error: checkout, the health check, and the merchant endpoints surface it as a 503.

### Connect the hosted checkout page

Store settings route enquiry through the hosted Bakong checkout page instead of the inline KHQR, either embedded in the store or as a full-page redirect.

1. With both `BAKONG_MERCHANT_TOKEN` and `BAKONG_CHECKOUT_API_URL` unset (default), the demo emulates the page: it mints local sessions, serves the browser payment endpoint, and settles from the page's demo controls. The switch works end to end without real credentials.
2. With both variables set, creating checkout with the page display mints a real `POST /v1/checkout/sessions` session with the merchant token and a UUID `Idempotency-Key`, returns its `checkout_url`, `session_id`, and `md5`, and settles each order only after the merchant backend reads and verifies the remote session (sections 6 and 7.2 of the checkout integration guide). The browser page and its messages are never trusted alone, and endpoint #5 cannot fulfil anything.
3. Setting one variable without the other is a configuration error; checkout, the health check, and the merchant endpoints surface it as a 503. The page switch stores your last choice in the browser and only appears when the provider is configured.

In full-page mode the page returns to the store's `/checkout/return` route with `{BILL_NO}` replaced by the order number; that route searches the store's cached order by bill number and never fulfils from unpacked query parameters.

### Merchant checkout-page endpoints

When the checkout page is available, these merchant endpoints follow the Bakong checkout integration guide's Open API shape (`{ "status": { "code", "message" }, "data": ... }` envelopes) instead of the storefront's own `{ "data": ... }` shape. They require `Authorization: Bearer <BAKONG_MERCHANT_TOKEN>` and reject duplicate idempotent writes:

| Method  | Endpoint                                    | Purpose                                                                                                                |
| ------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST`  | `/api/v1/checkout/sessions`                 | Mint a session with `amount`, `currency`, `billNo`, `successUrl`, `expirySeconds`, `description`, and a UUID `Idempotency-Key`; replaying a key returns the first response |
| `GET`   | `/api/v1/checkout/sessions`                 | List sessions; filter by `status`, `since`/`until`/`updated_since` epoch seconds, `billNo`, `limit`, and an opaque `cursor` |
| `GET`   | `/api/v1/checkout/sessions/<id>`            | Read one session; `wait=true&w=90` long-polls until a terminal status or the window closes                              |
| `POST`  | `/api/v1/checkout/sessions/<id>/cancel`     | Cancel a pending session; terminal sessions return 409                                                                  |

Unauthenticated storefront endpoints for the page itself:

| Method  | Endpoint                                        | Purpose                                                                                                                  |
| ------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/v1/checkout/sessions/<token>/payment`     | Sanitized browser payload (endpoint #5): status, amount, currency, merchant name, bill display, session expiry, QR image; no md5 or session id. One request per 2 seconds per token; extra calls return 429 with `Retry-After` |
| `POST`  | `/api/v1/checkout/sessions/<token>/simulate`    | Demo-only payment simulation from the hosted page's controls                                                              |

### Connect Bakong

1. For Polling, register for an API key through the [Bakong Open API portal](https://api-bakong.nbc.gov.kh/) or the [SIT portal](https://sit-api-bakong.nbc.org.kh/).
2. Set `PAYMENT_MODE=bakong` and `BAKONG_ACCOUNT_ID`. Add `BAKONG_TOKEN` and the matching `BAKONG_API_URL` only when using Polling.
3. Choose **Polling** for the directly documented Bakong MD5 API.
4. For webhook delivery, register `https://your-host/api/v1/transactions/callback` and choose Signed, Token, or Unsigned. Signed and Token use `WEBHOOK_SECRET`; webhook mode does not require a Bakong API token.

Credentials remain on the server. In Bakong mode the simulator returns 404. The health check tests local configuration and SQLite access; it does not claim to validate a Bakong token.

## API

All responses are JSON except the SSE endpoint. Transaction responses use `{ "data": { ... } }`; errors use `{ "error": "..." }` with a suitable HTTP status. Dynamic responses are not cached. Transaction amounts always come from the server-side product catalog.

| Method  | Endpoint                                               | Purpose                                                                            |
| ------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET`   | `/api/v1/health-check`                                 | Configuration/storage readiness, environment, supported update methods; 200 or 503 |
| `GET`   | `/api/v1/products`                                     | Catalog with saved USD/KHR prices                                                  |
| `PATCH` | `/api/v1/products/<productId>`                         | Save a product's price for the specified currency                                  |
| `POST`  | `/api/v1/transactions`                                 | Create an order and KHQR; returns 201                                              |
| `GET`   | `/api/v1/transactions`                                 | Most recent 30 orders in the current environment                                   |
| `POST`  | `/api/v1/transactions/callback`                        | Receive provider batch or compact payment callbacks                                |
| `GET`   | `/api/v1/transactions/search?md5=<md5>&method=polling` | Check the provider and return the transaction (`polling` is the default)           |
| `GET`   | `/api/v1/transactions/search?md5=<md5>&method=webhook` | Read locally recorded callback status without contacting Bakong                    |
| `GET`   | `/api/v1/transactions/events?md5=<md5>`                | SSE events named `transaction` containing the transaction object                   |
| `POST`  | `/api/v1/transactions/simulate`                        | Mock-only provider/callback simulation                                             |

Orders created with `checkoutPage: true` carry `checkoutPageMode` and mint a checkout-page session first: the response includes `checkoutUrl`, `checkoutSessionId`, and `checkoutPageMode` alongside the local order fields.

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
  -d '{"items":[{"productId":"mondulkiri-coffee","quantity":1}],"currency":"USD","method":"webhook","webhookSignatureMode":"unsigned"}'
```

Other product IDs: `everyday-cup`, `market-tote`, `daily-notes`, `quiet-candle`, `daily-bottle`. Quantities must be integers from 1–20; each product can appear once. Currencies are `USD` and `KHR`.

The response contains `orderNumber`, `md5`, the original `qr` string, a PNG `qrImage` data URL, server-calculated `amount`, `currency`, `expiresAt`, `status`, `webhookSignatureMode`, and an activity log. Every order has a unique reference embedded in its dynamic KHQR. Use `"webhookSignatureMode":"signed"`, `"token"`, or `"unsigned"`; omitting it uses the server default. Signed/token modes without `WEBHOOK_SECRET` return 409.

Optionally send `expectedAmount` with the displayed cart total. The server returns 409 if it differs from the current catalog total. The storefront uses this check and refreshes the catalog on an unsuccessful checkout.

### Receive the provider batch callback

The callback endpoint accepts the provider's batch envelope directly:

```json
{
  "requestId": "0001",
  "transactions": [
    {
      "fromAccountId": "sender_acc@cmcb",
      "toAccountId": "receiver_acc@devb",
      "assetId": "khr#nbc",
      "amount": 13700,
      "description": "Pay back",
      "createdDateMilli": 1676962944719,
      "hash": "805712c84f0e678d54adfa999835f0c415394732957bdd645e545d0d9969f802",
      "qrCode": "<complete KHQR string from checkout>",
      "qrType": "CORPORATE",
      "senderName": "Channit Rom",
      "senderAccount": "321456654",
      "senderBank": "CMCBKHPPXX",
      "status": "SUCCESS"
    }
  ]
}
```

For every entry, the server calculates `MD5(qrCode)` and finds the matching local order. The complete, untruncated `qrCode` is required. Provider metadata such as `description`, `qrType`/`qrCodeType`, `senderName`, `senderAccount`, and `senderBank` may be omitted or `null`. `SUCCESS` marks a matching order paid, `FAILED`/`DECLINED`/`REJECTED`/`CANCELLED` mark it failed, and `PENDING`/`PROCESSING` leave it pending. `khr#nbc` maps to KHR and `usd#nbc` maps to USD. Unrelated transfers in the same batch are acknowledged without changing any order.

A valid batch receives HTTP 200 with exactly:

```json
{
  "status": {
    "code": 0,
    "errorCode": null,
    "error": null,
    "message": null,
    "warning": null
  }
}
```

The Bakong developer portal's connectivity test (`isTest: true` or `hash: "TEST_CALLBACK_PROBE"`) is acknowledged with this same response without matching or changing any order, so the portal's endpoint test succeeds even though the probe is not tied to a payment.

In Bakong mode, webhook settlement uses only the order's saved Signed, Token, or Unsigned policy. It does not call `check_transaction_by_md5` and does not require `BAKONG_TOKEN`. The server still validates the amount, currency, and recipient against the order.

#### Callback logging

Every callback writes two structured entries to the terminal running Next.js:

- `KHQR_WEBHOOK_REQUEST` includes the timestamp, method, URL, content type/length, whether signature/timestamp/token headers were present, and the exact request body.
- `KHQR_WEBHOOK_RESPONSE` includes the processing duration, HTTP status/status text, content type, and exact response body.
- If reading the request fails before a body is available, `KHQR_WEBHOOK_REQUEST_ERROR` records the request metadata and error. The normal response log is still written.
- Bakong developer portal connectivity probes are recorded as `KHQR_WEBHOOK_TEST_PROBE` and acknowledged without matching an order.
- Signature and secret values are never logged. The body is logged as required for debugging and can contain account identifiers, amounts, and complete KHQR payloads; protect or redact terminal logs before sharing them.

### Receive an unsigned compact callback

For an order created with `"webhookSignatureMode":"unsigned"`, replace `MD5_FROM_CHECKOUT` with the returned 32-character MD5 and use the checkout's returned amount, currency, and account. This example matches one coffee order at its original mock price.

```bash
curl -X POST http://localhost:3000/api/v1/transactions/callback \
  -H 'Content-Type: application/json' \
  -d '{
    "md5":"MD5_FROM_CHECKOUT",
    "status":"paid",
    "amount":8.5,
    "currency":"USD",
    "toAccountId":"mock_store@devb",
    "transactionId":"mock-payment-001"
  }'
```

For a failed payment the body is `{ "md5": "MD5_FROM_CHECKOUT", "status": "failed" }`.

### Receive a token-authenticated callback

Create an order with `"webhookSignatureMode":"token"`, then send `WEBHOOK_SECRET` in this header:

```text
x-webhook-secret: YOUR_WEBHOOK_SECRET
```

Use the same compact or provider-batch body. The JSON body is not signed. Missing or incorrect tokens return 401; if the server has no `WEBHOOK_SECRET`, token mode returns 503. The simulator supplies the correct token automatically for token-mode mock orders.

### Receive a signed callback

Create an order with `"webhookSignatureMode":"signed"`, then generate these headers on the sending server:

```text
x-webhook-timestamp: <Unix timestamp in seconds>
x-webhook-signature: sha256=<64-character hexadecimal HMAC>
```

Bakong callbacks sign with a Stripe-compatible single header instead, which the receiver also accepts:

```text
webhook-signature: t=<Unix timestamp in seconds>,v1=<64-character hexadecimal HMAC>
```

Both forms use the same key and message: `HMAC-SHA256(WEBHOOK_SECRET, timestamp + "." + raw_request_body)`, with the timestamp embedded in the header for `t`/`v1` senders. A `t`/`v1` header may list several comma-separated `v1` values for key rotation; the callback is accepted when any of them matches. The timestamp must be within **±300 seconds** of server time. The exact UTF-8 JSON bytes sent over HTTP must match the signed bytes, including whitespace and trailing newlines.

Example sender using Node.js (use the amount, currency, account, and MD5 from your order):

```js
import { createHmac } from "node:crypto";

const secret = process.env.WEBHOOK_SECRET;
if (!secret)
  throw new Error("Set the same WEBHOOK_SECRET as the receiving server.");

const body = JSON.stringify({
  md5: "MD5_FROM_CHECKOUT",
  status: "paid",
  amount: 8.5,
  currency: "USD",
  toAccountId: "mock_store@devb",
  transactionId: "mock-payment-001",
});
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", secret)
  .update(`${timestamp}.${body}`)
  .digest("hex");

const response = await fetch(
  "http://localhost:3000/api/v1/transactions/callback",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": `sha256=${signature}`,
    },
    body,
  },
);
console.log(response.status, await response.json());
```

Missing, malformed, incorrect, or out-of-window signatures return 401. The receiver compares HMACs in constant time. Sign retries with a fresh timestamp; duplicate confirmed outcomes remain idempotent. If the signing key is removed, signed orders return 503 instead of accepting an unsigned callback.

Provider batches and compact callbacks validate the MD5, amount, currency, and recipient. Matching duplicate deliveries return 200 without adding duplicate events. Conflicting outcomes return 409 and cannot overwrite a settled payment. Malformed input returns 400, unsupported content type 415, invalid/missing authentication 401, and an unknown compact MD5 404.

### Poll by MD5

```bash
curl 'http://localhost:3000/api/v1/transactions/search?md5=MD5_FROM_CHECKOUT&method=polling'
```

Statuses: `pending`, `paid`, `failed`, `expired`. Bakong mode Polling requires `BAKONG_TOKEN`. Bakong's “transaction could not be found” response means `pending` until expiry. Provider authentication, network, and malformed-response errors are surfaced as 502 instead of being reported as a failed payment. Calls are coalesced in flight and successful checks are throttled to one per 3 seconds per transaction in a server process.

An expired payment may still be reconciled as paid by a verified late callback or explicit MD5 check. Expiry closes the payment window; it does not prove that funds were never transferred.

### Simulate a payment

```bash
curl -X POST http://localhost:3000/api/v1/transactions/simulate \
  -H 'Content-Type: application/json' \
  -d '{"md5":"MD5_FROM_CHECKOUT","status":"paid","method":"polling"}'
```

The next MD5 poll discovers this result. Use `"method":"webhook"` to exercise callback processing using the order's saved signed, token, or unsigned mode. The simulation request itself does not need authentication headers; the server adds them internally when required. This endpoint is only available for pending mock orders.

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

API tests use an isolated temporary database and test SDK output, editable price persistence/validation, stale cart detection, provider batch acknowledgement, batch-to-order matching, status mapping, signed/token/unsigned callbacks, raw-body tampering, signature timestamps, mode downgrade rejection, legacy authentication, idempotency, amount mismatches, expiry reconciliation, MD5 polling, streaming, separation of webhook authentication from Bakong polling credentials, and the hosted checkout page: merchant auth, UUID idempotency replay and drift, bill identity, sanitized payment payload with its two-second rate limit, emulated demo settlement for linked and standalone sessions, cancellation, wait-window validation, listing filters, health provider reporting, and partial-configuration rejection. Browser tests build the app and start a separate production-mode mock server on port 3197 (override with `E2E_PORT`) with their own SQLite database. They cover both status methods, all webhook authentication modes, failed payments, MD5 lookup, mobile KHR checkout, price edits through to checkout and reload, and both checkout-page modes (embedded iframe and full-page redirect). No real Bakong transfer is required for these tests.

## Bakong references consulted

- [NBC Bakong website and KHQR downloads](https://bakong.nbc.gov.kh/)
- [QR Payment Integration — v1.0.3](https://bakong.nbc.gov.kh/download/KHQR/integration/QR%20Payment%20Integration.pdf): dynamic QR flow, 10-minute maximum window, Bearer authentication, MD5 status API, and response examples.
- [KHQR SDK Document](https://bakong.nbc.gov.kh/download/KHQR/integration/KHQR%20SDK%20Document.pdf): JavaScript individual/merchant KHQR generation and verification.
- [`bakong-khqr` JavaScript SDK](https://www.npmjs.com/package/bakong-khqr): current dynamic QR expiration parameter and SDK usage.
- [Bakong Open API](https://api-bakong.nbc.gov.kh/)
