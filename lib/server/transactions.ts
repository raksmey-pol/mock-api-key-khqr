import { randomUUID } from "node:crypto";
import { BakongKHQR } from "bakong-khqr";
import QRCode from "qrcode";
import { z } from "zod";
import { priceOrder } from "../catalog";
import type { ProviderResult, Transaction, TransactionEvent } from "../types";
import { checkProvider } from "./bakong";
import { getConfig, POLL_INTERVAL_MS } from "./config";
import { ApiError } from "./http";
import { getProducts } from "./products";
import { insertTransaction, readTransaction, updateTransaction } from "./store";

export const md5Schema = z.string().regex(/^[a-fA-F0-9]{32}$/, "MD5 must be a 32-character hexadecimal string.").transform((value) => value.toLowerCase());
export const methodSchema = z.enum(["webhook", "polling"]);
export const checkoutSchema = z.object({
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(20) }).strict()).min(1).max(6),
  currency: z.enum(["USD", "KHR"]).default("USD"),
  method: methodSchema.default("polling"),
  expectedAmount: z.number().positive().optional(),
}).strict();

function addEvent(transaction: Transaction, source: TransactionEvent["source"], message: string) {
  const now = new Date().toISOString();
  transaction.updatedAt = now;
  transaction.events = [...transaction.events, { id: randomUUID(), at: now, source, message }].slice(-30);
  return transaction;
}

export async function createTransaction(body: unknown) {
  const input = checkoutSchema.parse(body);
  const config = getConfig();
  if (input.method === "webhook" && config.mode === "bakong" && !config.webhookSecret) {
    throw new ApiError(409, "Configure WEBHOOK_SECRET and a callback provider, or choose polling.");
  }
  let order: ReturnType<typeof priceOrder>;
  const catalog = getProducts();
  try { order = priceOrder(input.items, input.currency, catalog); } catch { throw new ApiError(400, "Choose valid, unique products from the store."); }
  if (input.expectedAmount !== undefined && input.expectedAmount !== order.amount) {
    throw new ApiError(409, "Product prices have changed. Review your updated bag and try checkout again.");
  }
  const id = randomUUID();
  const orderNumber = `MK-${id.replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  const now = new Date();
  const expiration = now.getTime() + config.expirationMinutes * 60_000;
  const details = {
    bakongAccountID: config.accountId,
    merchantName: config.merchantName,
    merchantCity: config.merchantCity,
    ...(config.acquiringBank ? { acquiringBank: config.acquiringBank } : {}),
    currency: input.currency === "USD" ? 840 : 116,
    amount: order.amount,
    billNumber: orderNumber,
    storeLabel: "Mekong Store",
    terminalLabel: "Web checkout",
    expirationTimestamp: expiration,
  };
  const sdk = new BakongKHQR();
  const response = config.merchantId
    ? sdk.generateMerchant({ ...details, merchantID: config.merchantId, acquiringBank: config.acquiringBank })
    : sdk.generateIndividual(details);
  const data = z.object({ qr: z.string(), md5: md5Schema }).safeParse(response.data);
  if (response.status.code !== 0 || !data.success) throw new ApiError(503, response.status.message ?? "KHQR generation failed. Check merchant settings.");
  if (!BakongKHQR.verify(data.data.qr).isValid) throw new ApiError(500, "Generated KHQR did not pass verification.");
  const transaction: Transaction = {
    id, orderNumber, ...data.data,
    qrImage: await QRCode.toDataURL(data.data.qr, { width: 400, margin: 4, errorCorrectionLevel: "M" }),
    ...order, currency: input.currency, status: "pending", method: input.method, mode: config.mode,
    merchantName: config.merchantName, accountId: config.accountId,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(expiration).toISOString(),
    checkedAt: null, paidAt: null, providerReference: null, events: [],
  };
  addEvent(transaction, "checkout", "Order created and dynamic KHQR generated.");
  insertTransaction(transaction);
  return transaction;
}

export function requireTransaction(md5: string) {
  const transaction = readTransaction(md5);
  if (!transaction) throw new ApiError(404, "No transaction found for this MD5.");
  return transaction;
}

export function getTransaction(md5: string) {
  requireTransaction(md5);
  return updateTransaction(md5, (transaction) => {
    if (transaction.status === "pending" && Date.parse(transaction.expiresAt) <= Date.now()) {
      transaction.status = "expired";
      addEvent(transaction, "system", "The payment window expired. A verified late payment can still be reconciled.");
    }
    return transaction;
  })!;
}

export function applyResult(md5: string, result: ProviderResult, source: "webhook" | "polling") {
  requireTransaction(md5);
  return updateTransaction(md5, (transaction) => {
    if (result.status === "paid") {
      if (result.amount !== transaction.amount || result.currency !== transaction.currency || result.toAccountId !== transaction.accountId) {
        throw new ApiError(409, "Payment amount, currency, or recipient does not match the order.");
      }
    }
    if (transaction.status === "paid" || transaction.status === "failed") {
      if (result.status !== transaction.status || (result.status === "paid" && transaction.providerReference !== result.transactionId)) {
        throw new ApiError(409, "This transaction has already been settled with a different result.");
      }
      return transaction; // Duplicate deliveries are idempotent.
    }
    if (source === "polling") transaction.checkedAt = new Date().toISOString();
    if (result.status === "pending") {
      if (Date.parse(transaction.expiresAt) <= Date.now() && transaction.status !== "expired") {
        transaction.status = "expired";
        addEvent(transaction, "system", "The payment window expired.");
      }
      return transaction;
    }
    // Expiration is local, not proof that funds were not transferred. Accept
    // authenticated/verified late settlements so a paid order is not lost.
    transaction.status = result.status;
    if (result.status === "paid") {
      transaction.providerReference = result.transactionId;
      transaction.paidAt = new Date().toISOString();
    }
    return addEvent(transaction, source, result.status === "paid"
      ? `Payment confirmed by ${source === "webhook" ? "webhook callback" : "MD5 polling"}.`
      : `Payment failed (${source}).`);
  })!;
}

const inFlight = new Map<string, Promise<Transaction>>();

export async function pollTransaction(md5: string) {
  const transaction = requireTransaction(md5);
  if (transaction.status === "paid" || transaction.status === "failed") return transaction;
  const pending = inFlight.get(md5);
  if (pending) return pending;
  if (transaction.checkedAt && Date.now() - Date.parse(transaction.checkedAt) < POLL_INTERVAL_MS) return getTransaction(md5);
  const check = (async () => {
    const result = await checkProvider(transaction);
    // A callback may have settled the transaction while the provider call ran.
    const latest = requireTransaction(md5);
    if (latest.status === "paid" || latest.status === "failed") return latest;
    return applyResult(md5, result, "polling");
  })();
  inFlight.set(md5, check);
  try { return await check; } finally { inFlight.delete(md5); }
}
