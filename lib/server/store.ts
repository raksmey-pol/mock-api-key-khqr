import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CheckoutSession, Currency, PaymentMode, ProviderResult, Transaction } from "../types";

const globalStore = globalThis as typeof globalThis & {
  khqrDatabase?: DatabaseSync;
  khqrProductPricesReady?: boolean;
  khqrCheckoutSessionsReady?: boolean;
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
  if (!globalStore.khqrCheckoutSessionsReady) {
    globalStore.khqrDatabase.exec(`
      CREATE TABLE IF NOT EXISTS checkout_sessions (
        session_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        bill_no TEXT NOT NULL,
        md5 TEXT UNIQUE,
        status TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkout_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkout_sessions_created ON checkout_sessions(created_at DESC);
      CREATE INDEX IF NOT EXISTS checkout_sessions_bill ON checkout_sessions(bill_no);
    `);
    globalStore.khqrCheckoutSessionsReady = true;
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

export function readTransactionByOrderNumber(orderNumber: string): Transaction | null {
  const row = database().prepare("SELECT body FROM transactions WHERE json_extract(body, '$.orderNumber') = ? ORDER BY created_at DESC LIMIT 1").get(orderNumber);
  return row ? JSON.parse(row.body as string) as Transaction : null;
}

export function readTransaction(md5: string): Transaction | null {
  const row = database().prepare("SELECT body FROM transactions WHERE md5 = ?").get(md5);
  return row ? JSON.parse(row.body as string) as Transaction : null;
}

export function readTransactionByCheckoutSessionId(sessionId: string): Transaction | null {
  const row = database().prepare("SELECT body FROM transactions WHERE json_extract(body, '$.checkoutSessionId') = ? ORDER BY created_at DESC LIMIT 1").get(sessionId);
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

const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "TIMEOUT", "EXPIRED", "CANCELLED"]);

function parseSession(row: unknown): CheckoutSession | null {
  if (!row) return null;
  const session = JSON.parse((row as { body: string }).body) as CheckoutSession;
  return session;
}

function sessionRow(session: CheckoutSession) {
  return [
    session.sessionId, session.token, session.billNo, session.md5,
    session.status, session.terminal ? 0 : 1, JSON.stringify(session),
    session.createdAt, session.updatedAt,
  ];
}

export function insertCheckoutSession(session: CheckoutSession) {
  const [id, token, billNo, md5, status, active, body, createdAt, updatedAt] = sessionRow(session);
  database().prepare(`
    INSERT INTO checkout_sessions (session_id, token, bill_no, md5, status, active, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, token, billNo, md5, status, active, body, createdAt, updatedAt);
}

export function activeBillSession(billNo: string): CheckoutSession | null {
  const row = database().prepare("SELECT body FROM checkout_sessions WHERE bill_no = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").get(billNo);
  return parseSession(row);
}

export function readCheckoutSession(sessionId: string): CheckoutSession | null {
  const row = database().prepare("SELECT body FROM checkout_sessions WHERE session_id = ?").get(sessionId);
  return parseSession(row);
}

export function readCheckoutSessionByToken(token: string): CheckoutSession | null {
  const row = database().prepare("SELECT body FROM checkout_sessions WHERE token = ?").get(token);
  return parseSession(row);
}

export function readCheckoutSessionByMd5(md5: string): CheckoutSession | null {
  const row = database().prepare("SELECT body FROM checkout_sessions WHERE md5 = ? ORDER BY created_at DESC LIMIT 1").get(md5);
  return parseSession(row);
}

// Keep every session read/modify/write atomic, mirroring the transaction store.
export function updateCheckoutSession(sessionId: string, update: (session: CheckoutSession) => CheckoutSession | null) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readCheckoutSession(sessionId);
    const next = current ? update(current) : null;
    if (next) {
      const [id, token, billNo, md5, status, active, body, createdAt, updatedAt] = sessionRow(next);
      db.prepare(`
        UPDATE checkout_sessions
        SET token = ?, bill_no = ?, md5 = ?, status = ?, active = ?, body = ?, created_at = ?, updated_at = ?
        WHERE session_id = ?
      `).run(token, billNo, md5, status, active, body, createdAt, updatedAt, id);
    }
    db.exec("COMMIT");
    return next;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listCheckoutSessions(options: {
  statuses?: string[];
  since?: number;
  until?: number;
  updatedSince?: number;
  billNo?: string;
  limit: number;
  cursor?: { createdAt: number; sessionId: string };
}): CheckoutSession[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.statuses?.length) {
    clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  if (options.since !== undefined) { clauses.push("created_at >= ?"); params.push(options.since); }
  if (options.until !== undefined) { clauses.push("created_at < ?"); params.push(options.until); }
  if (options.updatedSince !== undefined) { clauses.push("updated_at >= ?"); params.push(options.updatedSince); }
  if (options.billNo) { clauses.push("bill_no = ?"); params.push(options.billNo); }
  if (options.cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND session_id < ?))");
    params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.sessionId);
  }
  params.push(options.limit);
  const rows = database().prepare(`
    SELECT body FROM checkout_sessions
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY created_at DESC, session_id DESC LIMIT ?
  `).all(...params);
  return rows.map(parseSession).filter((session): session is CheckoutSession => session !== null);
}

export type CheckoutIdempotencyRecord = {
  payload: string;
  status: number;
  response: unknown;
};

export function readCheckoutIdempotency(key: string): CheckoutIdempotencyRecord | null {
  const row = database().prepare("SELECT payload, status, response FROM checkout_idempotency WHERE idempotency_key = ?").get(key) as
    | { payload: string; status: number; response: string }
    | undefined;
  return row ? { payload: row.payload, status: row.status, response: JSON.parse(row.response) } : null;
}

export function recordCheckoutIdempotency(key: string, payload: string, status: number, response: unknown) {
  database().prepare("INSERT INTO checkout_idempotency (idempotency_key, payload, status, response, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(key, payload, status, JSON.stringify(response), Date.now());
}

export { TERMINAL_STATUSES };
