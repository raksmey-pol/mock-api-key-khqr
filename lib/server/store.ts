import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Currency, PaymentMode, ProviderResult, Transaction } from "../types";

const globalStore = globalThis as typeof globalThis & {
  khqrDatabase?: DatabaseSync;
  khqrProductPricesReady?: boolean;
};

export function database() {
  if (!globalStore.khqrDatabase) {
    // Runtime data is created on disk, not bundled into the server build.
    const path = resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? ".data/khqr.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS transactions (
        md5 TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mock_payments (
        md5 TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transaction_date ON transactions(created_at DESC);
    `);
    globalStore.khqrDatabase = db;
  }
  // Also initialize for a connection that predates this feature during dev HMR.
  if (!globalStore.khqrProductPricesReady) {
    globalStore.khqrDatabase.exec(`
      CREATE TABLE IF NOT EXISTS product_prices (
        product_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency IN ('USD', 'KHR')),
        minor_amount INTEGER NOT NULL CHECK (minor_amount > 0),
        PRIMARY KEY (product_id, currency)
      );
    `);
    globalStore.khqrProductPricesReady = true;
  }
  return globalStore.khqrDatabase;
}

export function readProductPrices() {
  return database().prepare("SELECT product_id, currency, minor_amount FROM product_prices").all()
    .map((row) => ({
      productId: row.product_id as string,
      currency: row.currency as Currency,
      price: Number(row.minor_amount) / (row.currency === "USD" ? 100 : 1),
    }));
}

export function saveProductPrice(productId: string, currency: Currency, price: number) {
  database().prepare(`
    INSERT INTO product_prices (product_id, currency, minor_amount) VALUES (?, ?, ?)
    ON CONFLICT (product_id, currency) DO UPDATE SET minor_amount = excluded.minor_amount
  `).run(productId, currency, Math.round(price * (currency === "USD" ? 100 : 1)));
}

export function insertTransaction(transaction: Transaction) {
  database().prepare("INSERT INTO transactions (md5, created_at, body) VALUES (?, ?, ?)")
    .run(transaction.md5, transaction.createdAt, JSON.stringify(transaction));
}

export function readTransaction(md5: string): Transaction | null {
  const row = database().prepare("SELECT body FROM transactions WHERE md5 = ?").get(md5);
  return row ? JSON.parse(row.body as string) as Transaction : null;
}

// Keep read/modify/write atomic across both callback and polling requests.
export function updateTransaction(md5: string, update: (transaction: Transaction) => Transaction) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readTransaction(md5);
    const transaction = current ? update(current) : null;
    if (transaction) db.prepare("UPDATE transactions SET body = ? WHERE md5 = ?").run(JSON.stringify(transaction), md5);
    db.exec("COMMIT");
    return transaction;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recentTransactions(mode: PaymentMode): Transaction[] {
  return database().prepare("SELECT body FROM transactions WHERE json_extract(body, '$.mode') = ? ORDER BY created_at DESC LIMIT 30").all(mode)
    .map((row) => JSON.parse(row.body as string) as Transaction);
}

export function recordMockPayment(md5: string, result: ProviderResult) {
  // First settlement wins, just like a single-use dynamic payment request.
  database().prepare("INSERT OR IGNORE INTO mock_payments (md5, body) VALUES (?, ?)").run(md5, JSON.stringify(result));
}

export function readMockPayment(md5: string): ProviderResult {
  const row = database().prepare("SELECT body FROM mock_payments WHERE md5 = ?").get(md5);
  return row ? JSON.parse(row.body as string) as ProviderResult : { status: "pending" };
}
