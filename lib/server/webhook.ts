import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { checkProvider } from "./bakong";
import { getConfig } from "./config";
import { ApiError, apiError, json, readJson } from "./http";
import { applyResult, md5Schema, requireTransaction } from "./transactions";

export const callbackSchema = z.discriminatedUnion("status", [
  z.object({
    md5: md5Schema, status: z.literal("paid"), amount: z.number().positive(),
    currency: z.enum(["USD", "KHR"]), toAccountId: z.string().min(1).max(32),
    transactionId: z.string().min(1).max(128),
  }).strict(),
  z.object({ md5: md5Schema, status: z.literal("failed") }).strict(),
]);

export async function handleCallback(request: Request) {
  try {
    const config = getConfig();
    if (config.mode === "bakong" && !config.webhookSecret) throw new ApiError(503, "Webhook integration is not configured.");
    if (config.webhookSecret) {
      const received = Buffer.from(request.headers.get("x-webhook-secret") ?? "");
      const expected = Buffer.from(config.webhookSecret);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new ApiError(401, "Invalid webhook secret.");
    }
    const input = callbackSchema.parse(await readJson(request));
    const transaction = requireTransaction(input.md5);
    if (transaction.mode !== config.mode) throw new ApiError(409, "The callback does not match the current payment environment.");
    if (transaction.mode === "bakong" && input.status === "paid") {
      // A gateway callback is a notification; Bakong remains the payment authority.
      const verified = await checkProvider(transaction);
      if (verified.status !== "paid") throw new ApiError(409, "Bakong has not confirmed this payment yet. Retry the callback.");
      if (verified.transactionId !== input.transactionId) throw new ApiError(409, "Callback transaction ID does not match Bakong's transaction hash.");
      // Validate the supplied values as well as the independently verified receipt.
      if (input.amount !== verified.amount || input.currency !== verified.currency || input.toAccountId !== verified.toAccountId) {
        throw new ApiError(409, "Callback payment details do not match Bakong.");
      }
      return json({ received: true, data: applyResult(input.md5, verified, "webhook") });
    }
    return json({ received: true, data: applyResult(input.md5, input, "webhook") });
  } catch (error) { return apiError(error); }
}
