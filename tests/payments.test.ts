import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { Product, Transaction } from "../lib/types";

const directory = mkdtempSync(join(process.env.TEST_TMP_DIR ?? tmpdir(), "mekong-tests-"));
process.env.DATABASE_PATH = join(directory, "payments.sqlite");
process.env.PAYMENT_MODE = "mock";
process.env.WEBHOOK_SECRET = "integration-test-secret";

after(() => {
  database().close();
  rmSync(directory, { recursive: true, force: true });
});

function request(path: string, body: unknown, secret = "integration-test-secret") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": secret },
    body: JSON.stringify(body),
  });
}

async function order(method = "webhook", currency = "USD"): Promise<Transaction> {
  const response = await create(request("/api/v1/transactions", {
    items: [{ productId: "mondulkiri-coffee", quantity: 2 }, { productId: "everyday-cup", quantity: 1 }],
    currency, method,
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

test("Bakong mode checks the official endpoint, verifies callbacks, and disables mock settlement", async () => {
  process.env.PAYMENT_MODE = "bakong";
  process.env.BAKONG_ACCOUNT_ID = "test_merchant@devb";
  process.env.BAKONG_TOKEN = "test-server-token";
  process.env.BAKONG_API_URL = "https://bakong.example.test";
  const originalFetch = globalThis.fetch;
  try {
    const transaction = await order();
    assert.equal((await simulate(request("/simulate", { md5: transaction.md5, status: "paid", method: "webhook" }))).status, 404);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://bakong.example.test/v1/check_transaction_by_md5");
      assert.equal(options?.method, "POST");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-server-token");
      assert.deepEqual(JSON.parse(options!.body as string), { md5: transaction.md5 });
      return Response.json({ responseCode: 1, responseMessage: "Transaction could not be found.", data: null });
    };
    assert.equal((await callback(request("/callback", receipt(transaction)))).status, 409);
    globalThis.fetch = async () => Response.json({ responseCode: 0, data: {
      hash: receipt(transaction).transactionId, toAccountId: transaction.accountId,
      amount: transaction.amount + 1, currency: transaction.currency,
    } });
    assert.equal((await callback(request("/callback", receipt(transaction)))).status, 409);
    globalThis.fetch = async () => Response.json({ responseCode: 0, data: {
      hash: receipt(transaction).transactionId, toAccountId: transaction.accountId,
      amount: transaction.amount, currency: transaction.currency,
    } });
    assert.equal((await callback(request("/callback", receipt(transaction)))).status, 200);
    assert.equal(readTransaction(transaction.md5)?.status, "paid");
    const another = await order("polling");
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    assert.equal((await lookup(another.md5)).status, 502);
    assert.equal(readTransaction(another.md5)?.status, "pending");
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
