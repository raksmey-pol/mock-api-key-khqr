import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/server/config";
import { ApiError, apiError, json, readJson } from "@/lib/server/http";
import { readMockPayment, recordMockPayment } from "@/lib/server/store";
import { getTransaction, md5Schema, methodSchema } from "@/lib/server/transactions";
import { handleCallback } from "@/lib/server/webhook";
import { signWebhookBody } from "@/lib/server/webhook-signature";

export const runtime = "nodejs";

const schema = z.object({ md5: md5Schema, status: z.enum(["paid", "failed"]), method: methodSchema }).strict();

export async function POST(request: Request) {
  try {
    const config = getConfig();
    if (config.mode !== "mock") throw new ApiError(404, "The simulator is only available in mock mode.");
    const input = schema.parse(await readJson(request));
    const transaction = getTransaction(input.md5);
    if (transaction.mode !== "mock" || transaction.status !== "pending") throw new ApiError(409, "Only pending mock payments can be simulated.");
    if (input.method === "webhook" && transaction.webhookSignatureMode !== undefined && transaction.webhookSignatureMode !== "unsigned" && !config.webhookSecret) {
      throw new ApiError(503, "WEBHOOK_SECRET is required to simulate this authenticated webhook.");
    }
    recordMockPayment(input.md5, input.status === "paid" ? {
      status: "paid", amount: transaction.amount, currency: transaction.currency,
      toAccountId: transaction.accountId, transactionId: `mock-${randomUUID()}`,
    } : { status: "failed" });
    const payment = readMockPayment(input.md5);
    if (payment.status !== input.status) throw new ApiError(409, "A different mock outcome is already recorded.");
    if (input.method === "webhook") {
      const body = JSON.stringify({ md5: input.md5, ...payment });
      const headers = new Headers({ "Content-Type": "application/json" });
      if (transaction.webhookSignatureMode === "signed") {
        for (const [name, value] of Object.entries(signWebhookBody(body, config.webhookSecret))) headers.set(name, value);
      } else if (transaction.webhookSignatureMode === "token") {
        headers.set("x-webhook-secret", config.webhookSecret);
      } else if (transaction.webhookSignatureMode === undefined && config.webhookSecret) {
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
  } catch (error) { return apiError(error); }
}
