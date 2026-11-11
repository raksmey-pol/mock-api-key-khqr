import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { BakongKHQR } from "bakong-khqr";
import { GET as health } from "../app/api/v1/health-check/route";
import { POST as create, GET as list } from "../app/api/v1/transactions/route";
import { POST as callback } from "../app/api/v1/transactions/callback/route";
import { GET as search } from "../app/api/v1/transactions/search/route";
import { GET as events } from "../app/api/v1/transactions/events/route";
import { POST as simulate } from "../app/api/v1/transactions/simulate/route";
import { GET as catalog } from "../app/api/v1/products/route";
import { PATCH as editProduct } from "../app/api/v1/products/[productId]/route";
import { parseBakongResponse } from "../lib/server/bakong";
import { database, readTransaction, updateTransaction } from "../lib/server/store";
import type { Product, Transaction, WebhookSignatureMode } from "../lib/types";

const directory = mkdtempSync(join(process.env.TEST_TMP_DIR ?? tmpdir(), "mekong-tests-"));
process.env.DATABASE_PATH = join(directory, "payments.sqlite");
process.env.PAYMENT_MODE = "mock";
process.env.WEBHOOK_SECRET = "integration-test-secret";
process.env.WEBHOOK_SIGNATURE_MODE = "signed";

after(() => {
  database().close();
  rmSync(directory, { recursive: true, force: true });
});

function signatureHeaders(body: string, secret = "integration-test-secret", timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
  };
}

function stripeSignature(body: string, secret = "integration-test-secret", timestamp = String(Math.floor(Date.now() / 1000))) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function rawRequest(body: string, headers: Record<string, string> = {}, path = "/api/v1/transactions/callback") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function request(path: string, body: unknown, secret = "integration-test-secret") {
  const rawBody = JSON.stringify(body);
  return rawRequest(rawBody, signatureHeaders(rawBody, secret), path);
}

async function order(method = "webhook", currency = "USD", webhookSignatureMode?: WebhookSignatureMode): Promise<Transaction> {
  const response = await create(request("/api/v1/transactions", {
    items: [{ productId: "mondulkiri-coffee", quantity: 2 }, { productId: "everyday-cup", quantity: 1 }],
    currency, method, webhookSignatureMode,
  }));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

function receipt(transaction: Transaction) {
  return {
    md5: transaction.md5, status: "paid", amount: transaction.amount,
    currency: transaction.currency, toAccountId: transaction.accountId,
    transactionId: `payment-${transaction.id}`,
  };
}

function providerBatch(transaction: Transaction, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "0001",
    transactions: [{
      fromAccountId: "sender_acc@cmcb",
      toAccountId: transaction.accountId,
      assetId: `${transaction.currency.toLowerCase()}#nbc`,
      amount: transaction.amount,
      description: "Pay back",
      createdDateMilli: 1676962944719,
      hash: "805712c84f0e678d54adfa999835f0c415394732957bdd645e545d0d9969f802",
      qrCode: transaction.qr,
      qrType: "CORPORATE",
      senderName: "Channit Rom",
      senderAccount: "321456654",
      senderBank: "CMCBKHPPXX",
      status: "SUCCESS",
      ...overrides,
    }],
  };
}

const providerAcknowledgement = {
  status: { code: 0, errorCode: null, error: null, message: null, warning: null },
};

function lookup(md5: string, method = "polling") {
  return search(new Request(`http://localhost/api/v1/transactions/search?md5=${md5}&method=${method}`));
}

function patchPrice(productId: string, body: unknown) {
  return editProduct(new Request(`http://localhost/api/v1/products/${productId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ productId }) });
}

test("health checks configuration/storage and reports both mock update methods", async () => {
  const response = await health();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "mock");
  assert.equal(body.storage, "sqlite");
  assert.deepEqual(body.methods, ["webhook", "polling"]);
  assert.deepEqual(body.webhookSignatureModes, ["signed", "token", "unsigned"]);
  assert.equal(body.defaultWebhookSignatureMode, "signed");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!JSON.stringify(body).includes(process.env.WEBHOOK_SECRET!));
});

test("checkout creates distinct verifiable dynamic KHQRs with matching USD/KHR totals and MD5s", async () => {
  for (const currency of ["USD", "KHR"]) {
    const transaction = await order("polling", currency);
    assert.equal(transaction.amount, currency === "USD" ? 29 : 116000);
    assert.equal(createHash("md5").update(transaction.qr).digest("hex"), transaction.md5);
    assert.equal(BakongKHQR.verify(transaction.qr).isValid, true);
    const decoded = BakongKHQR.decode(transaction.qr).data as Record<string, string>;
    assert.equal(decoded.pointofInitiationMethod, "12");
    assert.equal(decoded.transactionCurrency, currency === "USD" ? "840" : "116");
    assert.equal(Number(decoded.transactionAmount), transaction.amount);
    assert.equal(decoded.billNumber, transaction.orderNumber);
    assert.equal(decoded.bakongAccountID, transaction.accountId);
    assert.equal(Number(decoded.expirationTimestamp), Date.parse(transaction.expiresAt));
    assert.ok(transaction.qrImage.startsWith("data:image/png;base64,"));
    assert.notEqual((await order("polling", currency)).md5, transaction.md5);
  }
});

test("checkout rejects forged prices, invalid quantities, duplicate/unknown products, and malformed bodies", async () => {
  for (const body of [
    { items: [{ productId: "daily-notes", quantity: 1 }], amount: 0.01 },
    { items: [{ productId: "daily-notes", quantity: 0 }] },
    { items: [{ productId: "daily-notes", quantity: 1.5 }] },
    { items: [{ productId: "daily-notes", quantity: 21 }] },
    { items: [{ productId: "missing", quantity: 1 }] },
    { items: [{ productId: "daily-notes", quantity: 1 }, { productId: "daily-notes", quantity: 1 }] },
    { items: [] },
    { items: [{ productId: "daily-notes", quantity: 1 }], currency: "EUR" },
  ]) assert.equal((await create(request("/api/v1/transactions", body))).status, 400);
  assert.equal((await create(new Request("http://localhost/api/v1/transactions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken",
  }))).status, 400);
  assert.equal((await create(new Request("http://localhost/api/v1/transactions", { method: "POST", body: "{}" }))).status, 415);
  assert.equal((await lookup("not-an-md5")).status, 400);
  assert.equal((await lookup("0".repeat(32))).status, 404);
});

test("callbacks authenticate, verify payment details, settle once, and reject conflicting outcomes", async () => {
  const transaction = await order();
  assert.equal(transaction.webhookSignatureMode, "signed");
  const payload = receipt(transaction);
  assert.equal((await callback(request("/callback", payload, "wrong-secret"))).status, 401);
  for (const mismatch of [{ amount: 0.01 }, { currency: "KHR" }, { toAccountId: "someone_else@devb" }]) {
    assert.equal((await callback(request("/callback", { ...payload, ...mismatch }))).status, 409);
    assert.equal(readTransaction(transaction.md5)?.status, "pending");
  }
  const response = await callback(request("/callback", payload));
  assert.equal(response.status, 200);
  const settled = (await response.json()).data as Transaction;
  assert.equal(settled.status, "paid");
  assert.equal(settled.events.at(-1)?.source, "webhook");
  const duplicate = await callback(request("/callback", payload));
  assert.equal(duplicate.status, 200);
  assert.deepEqual((await duplicate.json()).data, settled);
  assert.equal((await callback(request("/callback", { md5: transaction.md5, status: "failed" }))).status, 409);
  assert.equal((await callback(request("/callback", { ...payload, transactionId: "different-payment" }))).status, 409);
  assert.equal((await callback(request("/callback", { ...payload, md5: "0".repeat(32) }))).status, 404);
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("polling simulation does not settle locally until the MD5 provider check runs", async () => {
  const transaction = await order("polling");
  const simulated = await simulate(request("/simulate", { md5: transaction.md5, status: "paid", method: "polling" }));
  assert.equal(simulated.status, 200);
  assert.equal((await simulated.json()).queued, true);
  const local = await lookup(transaction.md5.toUpperCase(), "webhook");
  assert.equal((await local.json()).data.status, "pending");
  const checked = (await (await lookup(transaction.md5)).json()).data as Transaction;
  assert.equal(checked.status, "paid");
  assert.equal(checked.events.at(-1)?.source, "polling");
  assert.ok(checked.checkedAt);
  assert.deepEqual((await (await lookup(transaction.md5)).json()).data, checked);
});

test("webhook simulation uses the callback receiver and failure is terminal", async () => {
  const transaction = await order();
  const response = await simulate(request("/simulate", { md5: transaction.md5, status: "failed", method: "webhook" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "failed");
  assert.equal(readTransaction(transaction.md5)?.events.at(-1)?.source, "webhook");
  assert.equal((await callback(request("/callback", receipt(transaction)))).status, 409);
  assert.equal((await simulate(request("/simulate", { md5: transaction.md5, status: "paid", method: "webhook" }))).status, 409);
});

test("expiry stops the payment window while allowing an authenticated late payment to reconcile", async () => {
  const transaction = await order();
  updateTransaction(transaction.md5, (current) => ({ ...current, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await (await lookup(transaction.md5, "webhook")).json()).data.status, "expired");
  assert.equal((await simulate(request("/simulate", { md5: transaction.md5, status: "paid", method: "webhook" }))).status, 409);
  assert.equal((await callback(request("/callback", receipt(transaction)))).status, 200);
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("SSE streams callback status changes and supports cancellation", async () => {
  const transaction = await order();
  const response = await events(new Request(`http://localhost/api/v1/transactions/events?md5=${transaction.md5}`));
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: transaction/);
  assert.match(first, /"status":"pending"/);
  await callback(request("/callback", receipt(transaction)));
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"status":"paid"/);
  assert.equal((await reader.read()).done, true);

  const another = await order();
  const cancellable = await events(new Request(`http://localhost/api/v1/transactions/events?md5=${another.md5}`));
  await cancellable.body!.cancel();
});

test("transactions persist and are readable from a separate Node process", async () => {
  const transaction = await order();
  const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.DATABASE_PATH); const row=db.prepare('SELECT body FROM transactions WHERE md5 = ?').get(process.env.TEST_MD5); process.stdout.write(JSON.parse(row.body).id); db.close();`;
  const result = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TEST_MD5: transaction.md5 }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, transaction.id);
  const response = await list();
  assert.ok((await response.json()).data.some((item: Transaction) => item.md5 === transaction.md5));
});

test("Bakong response handling separates pending/failed transfers from provider errors", () => {
  assert.deepEqual(parseBakongResponse({ responseCode: 1, errorCode: 1, data: null, responseMessage: "Transaction could not be found. Please check and try again." }), { status: "pending" });
  assert.deepEqual(parseBakongResponse({ responseCode: 1, errorCode: 1, data: null, responseMessage: "Transaction failed." }), { status: "failed" });
  assert.throws(() => parseBakongResponse({ responseCode: 1, responseMessage: "Token expired" }), /could not check/);
  assert.throws(() => parseBakongResponse({ responseCode: 0, data: null }), /invalid payment details/);
  assert.throws(() => parseBakongResponse("not a response"), /invalid response/);
});

test("Bakong mode uses the Open API only for polling and disables mock settlement", async () => {
  process.env.PAYMENT_MODE = "bakong";
  process.env.BAKONG_ACCOUNT_ID = "test_merchant@devb";
  process.env.BAKONG_TOKEN = "test-server-token";
  process.env.BAKONG_API_URL = "https://bakong.example.test";
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Webhook must not call Bakong Open API."); };
    const webhookTransaction = await order("webhook", "USD", "signed");
    assert.equal((await simulate(request("/simulate", { md5: webhookTransaction.md5, status: "paid", method: "webhook" }))).status, 404);
    assert.equal((await callback(request("/callback", receipt(webhookTransaction)))).status, 200);
    assert.equal(calls, 0);
    assert.equal(readTransaction(webhookTransaction.md5)?.status, "paid");

    const pollingTransaction = await order("polling");
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "https://bakong.example.test/v1/check_transaction_by_md5");
      assert.equal(options?.method, "POST");
      assert.equal(new Headers(options?.headers).get("x-api-key"), "test-server-token");
      assert.deepEqual(JSON.parse(options!.body as string), { md5: pollingTransaction.md5 });
      return Response.json({
        responseCode: 0, data: {
          hash: "b".repeat(64), toAccountId: pollingTransaction.accountId,
          amount: pollingTransaction.amount, currency: pollingTransaction.currency,
        }
      });
    };
    const checked = await lookup(pollingTransaction.md5);
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).data.status, "paid");
    assert.equal(calls, 1);

    const unauthorized = await order("polling");
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    assert.equal((await lookup(unauthorized.md5)).status, 502);
    assert.equal(readTransaction(unauthorized.md5)?.status, "pending");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PAYMENT_MODE = "mock";
  }
});

test("saved USD/KHR prices persist and new KHQRs use them while existing orders keep their payment amount", async () => {
  const originalCatalog = await catalog();
  assert.equal(originalCatalog.headers.get("cache-control"), "no-store");
  const original = (await originalCatalog.json()).data.find((product: Product) => product.id === "daily-notes") as Product;
  const createNotesOrder = async (currency: string) => {
    const response = await create(request("/transactions", { items: [{ productId: original.id, quantity: 3 }], currency }));
    assert.equal(response.status, 201);
    return (await response.json()).data as Transaction;
  };
  const existing = await createNotesOrder("USD");
  try {
    const usd = await patchPrice(original.id, { currency: "USD", price: 0.29 });
    assert.equal(usd.status, 200);
    assert.deepEqual((await usd.json()).data.price, { USD: 0.29, KHR: original.price.KHR });
    const khr = await patchPrice(original.id, { currency: "KHR", price: 137 });
    assert.equal(khr.status, 200);
    assert.deepEqual((await khr.json()).data.price, { USD: 0.29, KHR: 137 });
    const saved = (await (await catalog()).json()).data.find((product: Product) => product.id === original.id);
    assert.deepEqual(saved.price, { USD: 0.29, KHR: 137 });

    for (const currency of ["USD", "KHR"]) {
      const transaction = await createNotesOrder(currency);
      assert.equal(transaction.amount, currency === "USD" ? 0.87 : 411);
      assert.equal(transaction.items[0].unitPrice, currency === "USD" ? 0.29 : 137);
      const decoded = BakongKHQR.decode(transaction.qr).data as Record<string, string>;
      assert.equal(decoded.transactionCurrency, currency === "USD" ? "840" : "116");
      assert.equal(Number(decoded.transactionAmount), transaction.amount);
      assert.equal(BakongKHQR.verify(transaction.qr).isValid, true);
    }

    const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.DATABASE_PATH); process.stdout.write(JSON.stringify(db.prepare('SELECT currency, minor_amount FROM product_prices WHERE product_id = ? ORDER BY currency').all('daily-notes'))); db.close();`;
    const persisted = spawnSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8" });
    assert.equal(persisted.status, 0, persisted.stderr);
    assert.deepEqual(JSON.parse(persisted.stdout), [{ currency: "KHR", minor_amount: 137 }, { currency: "USD", minor_amount: 29 }]);
    assert.equal(readTransaction(existing.md5)?.amount, original.price.USD * 3);
    assert.equal((await callback(request("/callback", receipt(existing)))).status, 200);
  } finally {
    await patchPrice(original.id, { currency: "USD", price: original.price.USD });
    await patchPrice(original.id, { currency: "KHR", price: original.price.KHR });
  }
});

test("price updates reject invalid amounts/currencies and unknown products without changing the catalog", async () => {
  const before = (await (await catalog()).json()).data;
  for (const body of [
    { currency: "USD", price: 0 }, { currency: "USD", price: -1 },
    { currency: "USD", price: 0.005 }, { currency: "USD", price: 1.001 },
    { currency: "USD", price: 1_000_001 }, { currency: "USD", price: "1.00" },
    { currency: "USD", price: null }, { currency: "USD" },
    { currency: "KHR", price: 0 }, { currency: "KHR", price: 100.5 },
    { currency: "KHR", price: 1_000_000_001 }, { currency: "EUR", price: 1 },
    { currency: "USD", price: 1, name: "Unexpected rename" },
  ]) assert.equal((await patchPrice("daily-notes", body)).status, 400, JSON.stringify(body));
  assert.equal((await patchPrice("unknown-product", { currency: "USD", price: 1 })).status, 404);
  assert.deepEqual((await (await catalog()).json()).data, before);
});

test("checkout detects a stale cart total after a price edit and accepts the refreshed total", async () => {
  const original = (await (await catalog()).json()).data.find((product: Product) => product.id === "daily-bottle") as Product;
  const checkout = (expectedAmount: number) => create(request("/transactions", {
    items: [{ productId: original.id, quantity: 1 }], currency: "USD", expectedAmount,
  }));
  try {
    assert.equal((await patchPrice(original.id, { currency: "USD", price: 0.01 })).status, 200);
    const stale = await checkout(original.price.USD);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /prices have changed/);
    const refreshed = await checkout(0.01);
    assert.equal(refreshed.status, 201);
    assert.equal((await refreshed.json()).data.amount, 0.01);
  } finally {
    await patchPrice(original.id, { currency: "USD", price: original.price.USD });
  }
});

test("signed callbacks verify exact bytes and reject missing, modified, stale, and future signatures", async () => {
  const transaction = await order("webhook", "USD", "signed");
  const payload = { ...receipt(transaction), transactionId: "បង់ប្រាក់-payment-123" };
  const body = JSON.stringify(payload, null, 2) + "\n";
  const headers = signatureHeaders(body);
  const now = Math.floor(Date.now() / 1000);
  const invalidRequests = [
    rawRequest(body),
    rawRequest(body, { "x-webhook-secret": "integration-test-secret" }),
    rawRequest(body, { "x-webhook-timestamp": headers["x-webhook-timestamp"] }),
    rawRequest(body, { "x-webhook-signature": headers["x-webhook-signature"] }),
    rawRequest(body, { ...headers, "x-webhook-signature": "sha256=invalid" }),
    rawRequest(body, { ...headers, "x-webhook-timestamp": "not-a-timestamp" }),
    rawRequest(body, signatureHeaders(body, "wrong-key")),
    rawRequest(body, signatureHeaders(body, "integration-test-secret", String(now - 301))),
    rawRequest(body, signatureHeaders(body, "integration-test-secret", String(now + 600))),
    rawRequest(body, { ...headers, "x-webhook-timestamp": String(now - 1) }),
    rawRequest(JSON.stringify(payload), headers),
    rawRequest(JSON.stringify({ ...payload, amount: payload.amount + 1 }), headers),
    rawRequest(body, {}, "/api/v1/transactions/callback?webhookSignatureMode=unsigned"),
    rawRequest(JSON.stringify({ ...payload, webhookSignatureMode: "unsigned" })),
  ];
  for (const invalid of invalidRequests) {
    assert.equal((await callback(invalid)).status, 401);
    assert.equal(readTransaction(transaction.md5)?.status, "pending");
  }
  assert.equal((await callback(rawRequest(body, headers))).status, 200);
  const settled = readTransaction(transaction.md5)!;
  assert.equal(settled.status, "paid");
  assert.equal(settled.providerReference, payload.transactionId);
  assert.equal((await callback(rawRequest(body, headers))).status, 200);
  assert.deepEqual(readTransaction(transaction.md5), settled);
});

test("signed callbacks also accept Bakong's webhook-signature t/v1 header", async () => {
  const transaction = await order("webhook", "USD", "signed");
  const payload = receipt(transaction);
  const body = JSON.stringify(payload);
  const now = Math.floor(Date.now() / 1000);
  const invalid = [
    rawRequest(body),
    rawRequest(body, { "webhook-signature": `t=not-a-timestamp,v1=${"a".repeat(64)}` }),
    rawRequest(body, { "webhook-signature": "t=1792137009,v1=invalid" }),
    rawRequest(body, { "webhook-signature": `t=${now},v1=${"a".repeat(64)}` }),
    rawRequest(body, { "webhook-signature": "sha256=" + "a".repeat(64) }),
    rawRequest(body, { "webhook-signature": stripeSignature(body, "wrong-key") }),
    rawRequest(body, { "webhook-signature": stripeSignature(body, "integration-test-secret", String(now - 301)) }),
    rawRequest(body, { "webhook-signature": stripeSignature(body, "integration-test-secret", String(now + 600)) }),
    rawRequest(JSON.stringify({ ...payload, amount: payload.amount + 1 }), { "webhook-signature": stripeSignature(body) }),
  ];
  for (const request of invalid) {
    assert.equal((await callback(request)).status, 401);
    assert.equal(readTransaction(transaction.md5)?.status, "pending");
  }
  const rotated = { "webhook-signature": stripeSignature(body).replace("v1=", `v1=${"0".repeat(64)},v1=`) };
  assert.equal((await callback(rawRequest(body, rotated))).status, 200);
  const settled = readTransaction(transaction.md5)!;
  assert.equal(settled.status, "paid");
  assert.equal((await callback(rawRequest(body, rotated))).status, 200);
  assert.deepEqual(readTransaction(transaction.md5), settled);
});

test("signed provider batch callbacks also accept the Bakong t/v1 header", async () => {
  const transaction = await order("webhook", "KHR", "signed");
  const body = JSON.stringify(providerBatch(transaction));
  assert.equal((await callback(rawRequest(body))).status, 401);
  assert.equal(readTransaction(transaction.md5)?.status, "pending");
  const signed = await callback(rawRequest(body, { "webhook-signature": stripeSignature(body) }));
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), providerAcknowledgement);
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("signed mode stays bound to the checkout when the default changes or the signing key is removed", async () => {
  const transaction = await order("webhook", "USD", "signed");
  const payload = receipt(transaction);
  try {
    process.env.WEBHOOK_SIGNATURE_MODE = "unsigned";
    assert.equal((await callback(rawRequest(JSON.stringify(payload)))).status, 401);
    process.env.WEBHOOK_SECRET = "";
    assert.equal((await callback(rawRequest(JSON.stringify(payload)))).status, 503);
    assert.equal((await simulate(request("/simulate", { md5: transaction.md5, status: "paid", method: "webhook" }))).status, 503);
    assert.equal(readTransaction(transaction.md5)?.status, "pending");
  } finally {
    process.env.WEBHOOK_SIGNATURE_MODE = "signed";
    process.env.WEBHOOK_SECRET = "integration-test-secret";
  }
  assert.equal((await callback(request("/callback", payload))).status, 200);
});

test("unsigned callbacks accept plain JSON even with a configured signing key and retain payment validation", async () => {
  const transaction = await order("webhook", "USD", "unsigned");
  assert.equal(transaction.webhookSignatureMode, "unsigned");
  assert.equal(readTransaction(transaction.md5)?.webhookSignatureMode, "unsigned");
  const payload = receipt(transaction);
  assert.equal((await callback(rawRequest(JSON.stringify({ ...payload, amount: 0.01 })))).status, 409);
  assert.equal(readTransaction(transaction.md5)?.status, "pending");
  assert.equal((await callback(rawRequest(JSON.stringify(payload)))).status, 200);
  const settled = readTransaction(transaction.md5)!;
  assert.equal(settled.status, "paid");
  assert.equal((await callback(rawRequest(JSON.stringify(payload)))).status, 200);
  assert.deepEqual(readTransaction(transaction.md5), settled);
});

test("signed, token, and unsigned simulator callbacks settle with their saved mode", async () => {
  for (const mode of ["signed", "token", "unsigned"] as const) {
    for (const status of ["paid", "failed"] as const) {
      const transaction = await order("webhook", "USD", mode);
      const response = await simulate(request("/simulate", { md5: transaction.md5, status, method: "webhook" }));
      assert.equal(response.status, 200);
      const data = (await response.json()).data as Transaction;
      assert.equal(data.status, status);
      assert.equal(data.webhookSignatureMode, mode);
      assert.equal(data.events.at(-1)?.source, "webhook");
    }
  }
});

test("unsigned mode works without a secret and authenticated modes require a configured key", async () => {
  try {
    process.env.WEBHOOK_SECRET = "";
    process.env.WEBHOOK_SIGNATURE_MODE = "";
    const response = await health();
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.deepEqual(config.webhookSignatureModes, ["unsigned"]);
    assert.equal(config.defaultWebhookSignatureMode, "unsigned");
    const transaction = await order();
    assert.equal(transaction.webhookSignatureMode, "unsigned");
    assert.equal((await callback(rawRequest(JSON.stringify(receipt(transaction))))).status, 200);
    for (const mode of ["signed", "token"] as const) {
      const authenticated = await create(request("/transactions", { items: [{ productId: "market-tote", quantity: 1 }], method: "webhook", webhookSignatureMode: mode }));
      assert.equal(authenticated.status, 409);
    }
    process.env.WEBHOOK_SIGNATURE_MODE = "token";
    assert.equal((await health()).status, 503);
  } finally {
    process.env.WEBHOOK_SECRET = "integration-test-secret";
    process.env.WEBHOOK_SIGNATURE_MODE = "signed";
  }
});

test("legacy transactions retain the shared-secret callback contract", async () => {
  const transaction = await order();
  updateTransaction(transaction.md5, (current) => {
    delete current.webhookSignatureMode;
    return current;
  });
  const body = JSON.stringify(receipt(transaction));
  assert.equal((await callback(rawRequest(body))).status, 401);
  assert.equal((await callback(rawRequest(body, { "x-webhook-secret": "wrong" }))).status, 401);
  assert.equal((await callback(rawRequest(body, { "x-webhook-secret": "integration-test-secret" }))).status, 200);
});

test("Bakong unsigned webhooks settle without BAKONG_TOKEN or Open API verification", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PAYMENT_MODE = "bakong";
  process.env.BAKONG_ACCOUNT_ID = "test_merchant@devb";
  process.env.BAKONG_TOKEN = "";
  process.env.WEBHOOK_SIGNATURE_MODE = "unsigned";
  process.env.WEBHOOK_SECRET = "";
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Webhook must not call Bakong Open API."); };
    const transaction = await order("webhook", "USD", "unsigned");
    const response = await callback(rawRequest(JSON.stringify(receipt(transaction))));
    assert.equal(response.status, 200);
    assert.equal(calls, 0);
    assert.equal(readTransaction(transaction.md5)?.status, "paid");
    const healthBody = await (await health()).json();
    assert.deepEqual(healthBody.methods, ["webhook"]);
    const pollingCheckout = await create(request("/transactions", { items: [{ productId: "market-tote", quantity: 1 }], method: "polling" }));
    assert.equal(pollingCheckout.status, 409);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PAYMENT_MODE = "mock";
    process.env.BAKONG_TOKEN = "integration-test-token";
    process.env.WEBHOOK_SIGNATURE_MODE = "signed";
    process.env.WEBHOOK_SECRET = "integration-test-secret";
  }
});

test("webhook logging records the exact request and response bodies", async () => {
  const transaction = await order("webhook", "KHR", "unsigned");
  const body = JSON.stringify(providerBatch(transaction));
  const originalInfo = console.info;
  const entries: string[] = [];
  console.info = (...values: unknown[]) => { entries.push(values.map(String).join(" ")); };
  let response: Response;
  try {
    response = await callback(rawRequest(body));
  } finally {
    console.info = originalInfo;
  }
  assert.equal(response.status, 200);
  const requestEntry = entries.find((entry) => entry.startsWith("KHQR_WEBHOOK_REQUEST "));
  const responseEntry = entries.find((entry) => entry.startsWith("KHQR_WEBHOOK_RESPONSE "));
  assert.ok(requestEntry);
  assert.ok(responseEntry);
  const requestLog = JSON.parse(requestEntry.slice("KHQR_WEBHOOK_REQUEST ".length));
  const responseLog = JSON.parse(responseEntry.slice("KHQR_WEBHOOK_RESPONSE ".length));
  assert.deepEqual(requestLog.body, JSON.parse(body));
  assert.deepEqual(requestLog.authentication, { signatureProvided: false, timestampProvided: false, tokenProvided: false });
  assert.equal(responseLog.status, 200);
  assert.deepEqual(responseLog.body, providerAcknowledgement);
  assert.equal(typeof responseLog.durationMs, "number");
});

test("provider batch callbacks accept nullable remittance metadata", async () => {
  const transaction = await order("webhook", "KHR", "unsigned");
  const payload = {
    requestId: "a818a3d5-3a92-46e4-9417-aaf695282baf",
    transactions: [{
      fromAccountId: "raksmey_pol@bkrt",
      toAccountId: transaction.accountId,
      assetId: "khr#nbc",
      amount: transaction.amount,
      description: transaction.orderNumber,
      createdDateMilli: 1790328965000,
      hash: "61dd1ea1d744184e75d74564aa5aac02a63e0dd2c0ed6ade076736d05648e5ed",
      qrCode: transaction.qr,
      qrCodeType: "REMITTANCE",
      senderName: null,
      senderAccount: null,
      senderBank: "BKRTKHPPXXX",
      status: "SUCCESS",
    }],
  };
  const response = await callback(rawRequest(JSON.stringify(payload)));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), providerAcknowledgement);
  const settled = readTransaction(transaction.md5)!;
  assert.equal(settled.status, "paid");
  assert.equal(settled.providerReference, payload.transactions[0].hash);
});

test("provider batch callbacks acknowledge the exact contract, ignore unrelated transfers, and settle matching orders", async () => {
  const transaction = await order("webhook", "KHR", "unsigned");
  const payload = {
    requestId: "0001",
    transactions: [
      providerBatch(transaction, { hash: "a".repeat(64), qrCode: "000201010212unrelated", amount: 5000 }).transactions[0],
      providerBatch(transaction).transactions[0],
    ],
  };
  const body = JSON.stringify(payload);
  const response = await callback(rawRequest(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), providerAcknowledgement);
  const settled = readTransaction(transaction.md5)!;
  assert.equal(settled.status, "paid");
  assert.equal(settled.providerReference, payload.transactions[1].hash);
  assert.equal(settled.events.at(-1)?.source, "webhook");
  const duplicate = await callback(rawRequest(body));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), providerAcknowledgement);
  assert.deepEqual(readTransaction(transaction.md5), settled);
});

test("provider batch callbacks map failure and pending states while acknowledging them", async () => {
  for (const [providerStatus, expectedStatus] of [
    ["FAILED", "failed"],
    ["DECLINED", "failed"],
    ["PENDING", "pending"],
    ["PROCESSING", "pending"],
  ] as const) {
    const transaction = await order("webhook", "USD", "unsigned");
    const response = await callback(rawRequest(JSON.stringify(providerBatch(transaction, { status: providerStatus }))));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), providerAcknowledgement);
    assert.equal(readTransaction(transaction.md5)?.status, expectedStatus);
  }
});

test("provider batch callbacks validate matching entries and reject malformed or unsupported batches", async () => {
  const mismatches = [
    [{ amount: 0.01 }, 409],
    [{ toAccountId: "someone_else@devb" }, 409],
    [{ assetId: "eur#nbc" }, 400],
    [{ status: "UNKNOWN" }, 400],
  ] as const;
  for (const [mismatch, expectedStatus] of mismatches) {
    const transaction = await order("webhook", "USD", "unsigned");
    const response = await callback(rawRequest(JSON.stringify(providerBatch(transaction, mismatch))));
    assert.equal(response.status, expectedStatus, JSON.stringify(mismatch));
    assert.equal(readTransaction(transaction.md5)?.status, "pending");
  }
  for (const payload of [
    { requestId: "0001", transactions: [] },
    { requestId: "0001", transactions: [{ ...providerBatch(await order()).transactions[0], hash: "invalid" }] },
    { requestId: "0001", transactions: [{ ...providerBatch(await order()).transactions[0], qrCode: undefined }] },
  ]) assert.equal((await callback(rawRequest(JSON.stringify(payload)))).status, 400);
});

test("Bakong portal connectivity probes are acknowledged without touching storage", async () => {
  const probes = [
    { isTest: true },
    { hash: "TEST_CALLBACK_PROBE" },
    {
      isTest: true,
      hash: "TEST_CALLBACK_PROBE",
      instructionRef: "TEST_CALLBACK_PROBE",
      externalRef: "TEST_CALLBACK_PROBE",
      fromAccountId: "test@bakong",
      toAccountId: "test@bakong",
      receiverBank: "TEST",
      receiverBankAccount: "test@bakong",
      trackingStatus: "SUCCESS",
      amount: 0,
      currency: "USD",
      description: "Bakong Open API test callback — no action required",
      createdDateMs: 1791252799686,
    },
  ];
  for (const probe of probes) {
    const response = await callback(rawRequest(JSON.stringify(probe)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), providerAcknowledgement);
  }
});

test("token provider batch callbacks require the shared x-webhook-secret header", async () => {
  const transaction = await order("webhook", "USD", "token");
  const body = JSON.stringify(providerBatch(transaction));
  assert.equal((await callback(rawRequest(body))).status, 401);
  assert.equal((await callback(rawRequest(body, { "x-webhook-secret": "wrong" }))).status, 401);
  assert.equal(readTransaction(transaction.md5)?.status, "pending");
  const response = await callback(rawRequest(body, { "x-webhook-secret": "integration-test-secret" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), providerAcknowledgement);
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("token callbacks also accept the credential in an Authorization bearer header", async () => {
  const transaction = await order("webhook", "USD", "token");
  const body = JSON.stringify(providerBatch(transaction));
  assert.equal((await callback(rawRequest(body))).status, 401);
  assert.equal((await callback(rawRequest(body, { authorization: "Bearer wrong" }))).status, 401);
  assert.equal((await callback(rawRequest(body, { authorization: "integration-test-secret" }))).status, 401);
  assert.equal((await callback(rawRequest(body, { authorization: "Basic integration-test-secret" }))).status, 401);
  assert.equal(readTransaction(transaction.md5)?.status, "pending");
  const response = await callback(rawRequest(body, { authorization: "Bearer integration-test-secret" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), providerAcknowledgement);
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("signed provider batch callbacks require a valid signature over the full batch body", async () => {
  const transaction = await order("webhook", "USD", "signed");
  const body = JSON.stringify(providerBatch(transaction));
  const unsigned = await callback(rawRequest(body));
  assert.equal(unsigned.status, 401);
  assert.equal(readTransaction(transaction.md5)?.status, "pending");
  const signed = await callback(rawRequest(body, signatureHeaders(body)));
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), providerAcknowledgement);
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("Bakong provider batch webhooks settle from webhook auth without Open API calls", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PAYMENT_MODE = "bakong";
  process.env.BAKONG_ACCOUNT_ID = "test_merchant@devb";
  process.env.BAKONG_TOKEN = "";
  process.env.BAKONG_API_URL = "https://bakong.example.test";
  process.env.WEBHOOK_SIGNATURE_MODE = "token";
  process.env.WEBHOOK_SECRET = "integration-test-secret";
  try {
    const transaction = await order("webhook", "KHR", "token");
    const payload = providerBatch(transaction, { hash: "b".repeat(64) });
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Webhook must not call Bakong Open API."); };
    const response = await callback(rawRequest(JSON.stringify(payload), { "x-webhook-secret": "integration-test-secret" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), providerAcknowledgement);
    assert.equal(calls, 0);
    assert.equal(readTransaction(transaction.md5)?.status, "paid");

    const mismatch = await order("webhook", "KHR", "token");
    const rejected = await callback(rawRequest(
      JSON.stringify(providerBatch(mismatch, { hash: "d".repeat(64), amount: mismatch.amount + 1 })),
      { "x-webhook-secret": "integration-test-secret" },
    ));
    assert.equal(rejected.status, 409);
    assert.equal(calls, 0);
    assert.equal(readTransaction(mismatch.md5)?.status, "pending");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PAYMENT_MODE = "mock";
    process.env.BAKONG_TOKEN = "integration-test-token";
    process.env.WEBHOOK_SIGNATURE_MODE = "signed";
    process.env.WEBHOOK_SECRET = "integration-test-secret";
  }
});

// ---------------------------------------------------------------------------
// Hosted checkout page
// ---------------------------------------------------------------------------

import { DEMO } from "../lib/server/config";
import { POST as mintSessions, GET as listSessions } from "../app/api/v1/checkout/sessions/route";
import { GET as readSession } from "../app/api/v1/checkout/sessions/[sessionId]/route";
import { POST as cancelSession } from "../app/api/v1/checkout/sessions/[sessionId]/cancel/route";
import { GET as paymentEndpoint } from "../app/api/v1/checkout/sessions/[sessionId]/payment/route";
import { POST as simulateSessionToken } from "../app/api/v1/checkout/sessions/[sessionId]/simulate/route";

type Envelope = { status: { code: string; message: string }; data: Record<string, unknown> };

function merchantGet(path: string, token = DEMO.MERCHANT_TOKEN) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function merchantPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let uniqueBillCount = 0;
function uniqueBill() {
  uniqueBillCount += 1;
  return `bill-${Date.now()}-${uniqueBillCount}`;
}

async function mintBill(billNo = uniqueBill(), extra: Record<string, unknown> = {}, key = randomUUID()) {
  const response = await mintSessions(merchantPost("/api/v1/checkout/sessions", {
    amount: 1.5, currency: "USD", billNo, ...extra,
  }, { authorization: `Bearer ${DEMO.MERCHANT_TOKEN}`, "idempotency-key": key }));
  const envelope = (await response.json()) as Envelope;
  assert.equal(response.status, 200, JSON.stringify(envelope));
  assert.equal(envelope.status.code, "00");
  return envelope.data as { checkout_url: string; session_id: string; md5: string; status: string; billNo: string; amount: number; currency: string };
}

test("checkout mint rejects missing merchant auth, bad idempotency keys, and invalid bills", async () => {
  const anonymous = await mintSessions(merchantPost("/api/v1/checkout/sessions", { amount: 1, currency: "USD", billNo: uniqueBill() }));
  assert.equal(anonymous.status, 401);

  const badKey = await mintSessions(merchantPost("/api/v1/checkout/sessions", { amount: 1, currency: "USD", billNo: uniqueBill() }, {
    authorization: `Bearer ${DEMO.MERCHANT_TOKEN}`,
    "idempotency-key": "not-a-uuid",
  }));
  assert.equal(badKey.status, 400);

  const wrongToken = await mintSessions(merchantPost("/api/v1/checkout/sessions", { amount: 1, currency: "USD", billNo: uniqueBill() }, {
    authorization: "Bearer mbk.not-the-demo-merchant",
    "idempotency-key": randomUUID(),
  }));
  assert.equal(wrongToken.status, 401);

  const badBill = await mintSessions(merchantPost("/api/v1/checkout/sessions", { amount: 1, currency: "USD", billNo: "invalid spaces!" }, {
    authorization: `Bearer ${DEMO.MERCHANT_TOKEN}`,
    "idempotency-key": randomUUID(),
  }));
  assert.equal(badBill.status, 400);
});

test("checkout mint replays idempotent keys and guards payload drift", async () => {
  const bill = uniqueBill();
  const key = randomUUID();
  const body = { amount: 2.25, currency: "USD", billNo: bill };
  const first = await mintSessions(merchantPost("/api/v1/checkout/sessions", body, { authorization: `Bearer ${DEMO.MERCHANT_TOKEN}`, "idempotency-key": key }));
  assert.equal(first.status, 200);
  const minted = (await first.json()) as Envelope;
  assert.equal(minted.status.code, "00");
  assert.match(String(minted.data.checkout_url), /^http:\/\/localhost\/checkout\/[\w-]+$/);
  assert.match(String(minted.data.md5), /^[a-f0-9]{32}$/);
  assert.equal(minted.data.status, "CREATED");

  const replay = await mintSessions(merchantPost("/api/v1/checkout/sessions", body, { authorization: `Bearer ${DEMO.MERCHANT_TOKEN}`, "idempotency-key": key }));
  assert.deepEqual(await replay.json(), minted);

  const drifted = await mintSessions(merchantPost("/api/v1/checkout/sessions", { ...body, amount: 5 }, { authorization: `Bearer ${DEMO.MERCHANT_TOKEN}`, "idempotency-key": key }));
  assert.equal(drifted.status, 422);
});

test("bill identity returns the pending session for an existing bill", async () => {
  const bill = uniqueBill();
  const first = await mintBill(bill);
  const again = await mintBill(bill);
  assert.equal(again.session_id, first.session_id);
  assert.equal(again.checkout_url, first.checkout_url);
});

test("payment payload hides credentials and honours its two second rate limit", async () => {
  const minted = await mintBill();
  const token = String(new URL(minted.checkout_url).pathname.split("/").at(-1));

  const payload = await paymentEndpoint(new Request(`http://localhost/api/v1/checkout/sessions/${token}/payment`), { params: Promise.resolve({ sessionId: token }) });
  assert.equal(payload.status, 200);
  const body = (await payload.json()) as Record<string, unknown>;
  assert.equal(body.status, "CREATED");
  assert.equal(body.amount, 1.5);
  assert.equal(body.currency, "USD");
  assert.ok("md5" in body === false);
  assert.ok("session_id" in body === false);
  assert.equal(body.merchant_origin, "http://localhost");

  await new Promise((resolve) => setTimeout(resolve, 120));
  const throttled = await paymentEndpoint(new Request(`http://localhost/api/v1/checkout/sessions/${token}/payment`), { params: Promise.resolve({ sessionId: token }) });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("Retry-After"), "2");
});

test("the emulated page demo controls settle the linked storefront order", async () => {
  const response = await create(request("/api/v1/transactions", {
    items: [{ productId: "mondulkiri-coffee", quantity: 1 }],
    currency: "USD", method: "polling",
    checkoutPage: true,
    checkoutPageMode: "iframe",
  }));
  assert.equal(response.status, 201);
  const transaction = (await (await response.json()) as { data: Transaction }).data;
  assert.ok(transaction.checkoutUrl, "checkoutUrl must be returned to the storefront");
  assert.ok(transaction.checkoutSessionId);
  assert.equal(transaction.checkoutPageMode, "iframe");
  assert.match(transaction.checkoutUrl, /\/checkout\/[\w-]+$/);
  assert.ok(transaction.events.some((event) => event.message.includes("Hosted checkout page session minted (mock).")));

  const token = new URL(transaction.checkoutUrl ?? "").pathname.split("/").at(-1) ?? "";
  const simulated = await simulateSessionToken(merchantPost(`/api/v1/checkout/sessions/${token}/simulate`, { status: "paid" }), { params: Promise.resolve({ sessionId: token }) });
  assert.equal(simulated.status, 200);

  // Polling orders settle on the next MD5 read, exactly like the storefront.
  const settled = await search(new Request(`http://localhost/api/v1/transactions/search?md5=${transaction.md5}&method=polling`));
  assert.equal((await settled.json() as { data: Transaction }).data.status, "paid");
  assert.equal(readTransaction(transaction.md5)?.status, "paid");

  const merchantView = await readSession(merchantGet(`/api/v1/checkout/sessions/${transaction.checkoutSessionId}`), { params: Promise.resolve({ sessionId: transaction.checkoutSessionId ?? "" }) });
  const envelope = (await merchantView.json()) as Envelope;
  assert.equal(envelope.status.code, "00");
  assert.equal(envelope.data.status, "SUCCESS");

  const lateSimulate = await simulateSessionToken(merchantPost(`/api/v1/checkout/sessions/${token}/simulate`, { status: "failed" }), { params: Promise.resolve({ sessionId: token }) });
  assert.equal(lateSimulate.status, 409);
});

test("standalone minted tokens cannot settle through the storefront simulator", async () => {
  const minted = await mintBill();
  const token = new URL(minted.checkout_url).pathname.split("/").at(-1) ?? "";
  const response = await simulateSessionToken(merchantPost(`/api/v1/checkout/sessions/${token}/simulate`, { status: "paid" }), { params: Promise.resolve({ sessionId: token }) });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /not linked to a storefront order/);
});

test("the page payment endpoint advances settled mock payments for the full-page flow", async () => {
  const response = await create(request("/api/v1/transactions", {
    items: [{ productId: "everyday-cup", quantity: 2 }],
    currency: "USD", method: "polling",
    checkoutPage: true,
    checkoutPageMode: "redirect",
  }));
  const transaction = (await (await response.json()) as { data: Transaction }).data;
  const token = new URL(transaction.checkoutUrl ?? "").pathname.split("/").at(-1) ?? "";

  // Mock settlement only queues; the payment payload must surface it itself
  // because the full-page redirect leaves the storefront's listeners behind.
  const simulated = await simulateSessionToken(merchantPost(`/api/v1/checkout/sessions/${token}/simulate`, { status: "paid" }), { params: Promise.resolve({ sessionId: token }) });
  assert.equal(simulated.status, 200);
  assert.equal(readTransaction(transaction.md5)?.status, "pending");

  await new Promise((resolve) => setTimeout(resolve, 2100));
  const payload = await paymentEndpoint(new Request(`http://localhost/api/v1/checkout/sessions/${token}/payment`), { params: Promise.resolve({ sessionId: token }) });
  const body = (await payload.json()) as { status: string };
  assert.equal(body.status, "SUCCESS");
  assert.equal(readTransaction(transaction.md5)?.status, "paid");
});

test("cancel frees a pending page session and its storefront order once", async () => {
  const response = await create(request("/api/v1/transactions", {
    items: [{ productId: "everyday-cup", quantity: 1 }],
    currency: "KHR", method: "webhook",
    checkoutPage: true,
    checkoutPageMode: "redirect",
  }));
  const transaction = (await (await response.json()) as { data: Transaction }).data;
  assert.ok(transaction.checkoutUrl);
  assert.equal(transaction.checkoutPageMode, "redirect");
  const sessionId = transaction.checkoutSessionId ?? "";

  const cancelled = await cancelSession(merchantPost(`/api/v1/checkout/sessions/${sessionId}/cancel`, {}, { authorization: `Bearer ${DEMO.MERCHANT_TOKEN}` }), { params: Promise.resolve({ sessionId }) });
  assert.equal(cancelled.status, 200);
  const envelope = (await cancelled.json()) as Envelope;
  assert.equal(envelope.data.status, "CANCELLED");
  assert.equal(readTransaction(transaction.md5)?.status, "failed");

  const repeat = await cancelSession(merchantPost(`/api/v1/checkout/sessions/${sessionId}/cancel`, {}, { authorization: `Bearer ${DEMO.MERCHANT_TOKEN}` }), { params: Promise.resolve({ sessionId }) });
  assert.equal(repeat.status, 409);
});

test("session reads validate the wait window", async () => {
  const minted = await mintBill();
  const badWindow = await readSession(merchantGet(`/api/v1/checkout/sessions/${minted.session_id}?wait=true&w=500`), { params: Promise.resolve({ sessionId: minted.session_id }) });
  assert.equal(badWindow.status, 400);
  const badWait = await readSession(merchantGet(`/api/v1/checkout/sessions/${minted.session_id}?wait=yes`), { params: Promise.resolve({ sessionId: minted.session_id }) });
  assert.equal(badWait.status, 400);
  const unknown = await readSession(merchantGet("/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000"), { params: Promise.resolve({ sessionId: "00000000-0000-0000-0000-000000000000" }) });
  assert.equal(unknown.status, 404);
});

test("merchant listing supports status filters and bill identity reconciliation", async () => {
  const bill = uniqueBill();
  await mintBill(bill);
  const page = await listSessions(merchantGet(`/api/v1/checkout/sessions?status=PENDING&billNo=${bill}&limit=10`));
  assert.equal(page.status, 200);
  const envelope = (await page.json()) as Envelope;
  assert.equal((envelope.data.sessions as unknown[]).length, 1);
  assert.equal(envelope.data.cursor, null);

  const badStatus = await listSessions(merchantGet("/api/v1/checkout/sessions?status=WEIRD"));
  assert.equal(badStatus.status, 400);
  const badLimit = await listSessions(merchantGet("/api/v1/checkout/sessions?limit=300"));
  assert.equal(badLimit.status, 400);
});

test("health reports the checkout page provider and rejects partial configuration", async () => {
  const healthy = await health();
  const body = (await healthy.json()) as Record<string, { available: boolean; provider: string }>;
  assert.equal(healthy.status, 200);
  assert.equal(body.checkoutPage.available, true);
  assert.equal(body.checkoutPage.provider, "mock");

  process.env.BAKONG_MERCHANT_TOKEN = "mbk.partial-configuration";
  try {
    const degraded = await health();
    assert.equal(degraded.status, 503);
  } finally {
    delete process.env.BAKONG_MERCHANT_TOKEN;
  }
  const restored = await health();
  assert.equal(restored.status, 200);
});
