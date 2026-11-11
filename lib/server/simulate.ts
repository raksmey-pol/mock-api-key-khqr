import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { ApiError, json } from "./http";
import { getTransaction } from "./transactions";
import { readMockPayment, recordMockPayment } from "./store";
import { handleCallback } from "./webhook";
import { signWebhookBody } from "./webhook-signature";
import type { StatusMethod, Transaction } from "../types";

// Shared mock simulation core for the MD5 endpoint and the checkout page demo.
// In webhook mode the exact callback receiver runs, including authentication
// and validation, so no external network hop is required.
export async function simulateMockPayment(parameters: {
  md5: string;
  status: "paid" | "failed";
  method?: StatusMethod;
}): Promise<Response> {
  const config = getConfig();
  if (config.mode !== "mock") throw new ApiError(404, "The simulator is only available in mock mode.");
  const transaction = getTransaction(parameters.md5);
  if (transaction.mode !== "mock" || transaction.status !== "pending") {
    throw new ApiError(409, "Only pending mock payments can be simulated.");
  }
  const method = parameters.method ?? transaction.method;
  if (method === "webhook" && transaction.webhookSignatureMode !== undefined && transaction.webhookSignatureMode !== "unsigned" && !config.webhookSecret) {
    throw new ApiError(503, "WEBHOOK_SECRET is required to simulate this authenticated webhook.");
  }
  recordMockPayment(transaction.md5, parameters.status === "paid" ? {
    status: "paid", amount: transaction.amount, currency: transaction.currency,
    toAccountId: transaction.accountId, transactionId: `mock-${randomUUID()}`,
  } : { status: "failed" });
  const payment = readMockPayment(transaction.md5);
  if (payment.status !== parameters.status) throw new ApiError(409, "A different mock outcome is already recorded.");
  if (method === "webhook") {
    const methodOf = (tx: Transaction) => tx.webhookSignatureMode;
    const signatureMode = methodOf(transaction);
    const body = JSON.stringify({ md5: transaction.md5, ...payment });
    const headers = new Headers({ "Content-Type": "application/json" });
    if (signatureMode === "signed") {
      for (const [name, value] of Object.entries(signWebhookBody(body, config.webhookSecret))) headers.set(name, value);
    } else if (signatureMode === "token") {
      headers.set("x-webhook-secret", config.webhookSecret);
    } else if (signatureMode === undefined && config.webhookSecret) {
      headers.set("x-webhook-secret", config.webhookSecret);
    }
    // Exercise the exact callback receiver, including authentication and validation,
    // without relying on a user-controlled Host header for an internal HTTP request.
    return handleCallback(new Request("http://localhost/api/v1/transactions/callback", {
      method: "POST",
      headers,
      body,
    }));
  }
  return json({ queued: true, message: "Mock provider updated. The next MD5 poll will discover this result." });
}
