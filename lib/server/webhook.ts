import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Currency, ProviderResult, Transaction } from "../types";
import { getConfig } from "./config";
import { ApiError, apiError, json, parseJson, readJsonBody } from "./http";
import { readTransaction } from "./store";
import { applyResult, md5Schema, requireTransaction } from "./transactions";
import { verifyWebhookSignature } from "./webhook-signature";

export const callbackSchema = z.discriminatedUnion("status", [
  z.object({
    md5: md5Schema, status: z.literal("paid"), amount: z.number().positive(),
    currency: z.enum(["USD", "KHR"]), toAccountId: z.string().min(1).max(64),
    transactionId: z.string().min(1).max(128),
  }).strict(),
  z.object({ md5: md5Schema, status: z.literal("failed") }).strict(),
]);

const providerTransactionSchema = z.object({
  fromAccountId: z.string().min(1).max(128),
  toAccountId: z.string().min(1).max(128),
  assetId: z.string().min(1).max(64),
  amount: z.number().positive().finite(),
  description: z.string().max(512).nullish(),
  createdDateMilli: z.number().int().nonnegative().optional(),
  hash: z.string().regex(/^[a-fA-F0-9]{64}$/, "Provider transaction hash must be 64 hexadecimal characters."),
  qrCode: z.string().min(1).max(4096),
  qrType: z.string().max(64).nullish(),
  qrCodeType: z.string().max(64).nullish(),
  senderName: z.string().max(256).nullish(),
  senderAccount: z.string().max(128).nullish(),
  senderBank: z.string().max(64).nullish(),
  status: z.string().min(1).max(64),
}).passthrough();

const providerBatchSchema = z.object({
  requestId: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]),
  transactions: z.array(providerTransactionSchema).min(1).max(100),
}).passthrough();

const failedProviderStatuses = new Set(["FAILED", "FAILURE", "DECLINED", "REJECTED", "CANCELLED", "CANCELED"]);
const pendingProviderStatuses = new Set(["PENDING", "PROCESSING", "IN_PROGRESS"]);

const redactedHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-webhook-secret",
  "x-webhook-signature",
]);

function loggableHeaders(headers: Headers) {
  const entries: Record<string, string> = {};
  for (const [name, value] of headers) {
    // entries[name] = redactedHeaders.has(name) ? `[redacted length=${value.length}]` : value;
    entries[name] = value
  }
  return entries;
}

function loggableBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function providerAcknowledgement() {
  return {
    status: {
      code: 0,
      errorCode: null,
      error: null,
      message: null,
      warning: null,
    },
  };
}

function providerCurrency(assetId: string): Currency {
  const code = assetId.split("#", 1)[0].trim().toUpperCase();
  if (code === "KHR" || code === "USD") return code;
  throw new ApiError(400, `Unsupported provider assetId: ${assetId}.`);
}

function providerResult(item: z.infer<typeof providerTransactionSchema>): ProviderResult {
  const status = item.status.trim().toUpperCase();
  if (status === "SUCCESS") {
    return {
      status: "paid",
      amount: item.amount,
      currency: providerCurrency(item.assetId),
      toAccountId: item.toAccountId,
      transactionId: item.hash.toLowerCase(),
    };
  }
  if (failedProviderStatuses.has(status)) return { status: "failed" };
  if (pendingProviderStatuses.has(status)) return { status: "pending" };
  throw new ApiError(400, `Unsupported provider transaction status: ${item.status}.`);
}

function webhookToken(headers: Headers) {
  const dedicated = headers.get("x-webhook-secret");
  if (dedicated) return dedicated;
  const authorization = headers.get("authorization");
  const bearer = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  return bearer ? bearer[1].trim() : "";
}

function verifyWebhookToken(headers: Headers, secret: string) {
  if (!secret) throw new ApiError(503, "WEBHOOK_SECRET is required for token webhook authentication.");
  const received = Buffer.from(webhookToken(headers));
  const expected = Buffer.from(secret);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ApiError(401, "Invalid webhook token.");
  }
}

function authenticateCallback(
  transaction: Transaction,
  rawBody: Uint8Array,
  headers: Headers,
  config: ReturnType<typeof getConfig>,
) {
  if (transaction.webhookSignatureMode === "signed") {
    verifyWebhookSignature(rawBody, headers, config.webhookSecret);
  } else if (transaction.webhookSignatureMode === "token") {
    verifyWebhookToken(headers, config.webhookSecret);
  } else if (transaction.webhookSignatureMode === undefined) {
    if (config.mode === "bakong" && !config.webhookSecret) throw new ApiError(503, "Webhook integration is not configured.");
    if (config.webhookSecret) verifyWebhookToken(headers, config.webhookSecret);
  }
}

async function handleProviderBatch(
  batch: z.infer<typeof providerBatchSchema>,
  rawBody: Uint8Array,
  headers: Headers,
  config: ReturnType<typeof getConfig>,
) {
  const matches = batch.transactions.flatMap((item) => {
    const md5 = createHash("md5").update(item.qrCode).digest("hex");
    const transaction = readTransaction(md5);
    if (!transaction) return [];
    if (transaction.mode !== config.mode) throw new ApiError(409, "The callback does not match the current payment environment.");
    authenticateCallback(transaction, rawBody, headers, config);
    return [{ md5, result: providerResult(item) }];
  });

  for (const match of matches) {
    applyResult(match.md5, match.result, "webhook");
  }

  return json(providerAcknowledgement());
}

async function logWebhookResponse(response: Response, startedAt: number) {
  const body = await response.clone().text();
  console.info("KHQR_WEBHOOK_RESPONSE", JSON.stringify({
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    headers: loggableHeaders(response.headers),
    body: loggableBody(body),
  }));
  return response;
}

export async function handleCallback(request: Request) {
  const startedAt = Date.now();
  let rawBody: Buffer | undefined;
  try {
    const config = getConfig();
    rawBody = await readJsonBody(request);
    console.info("KHQR_WEBHOOK_REQUEST", JSON.stringify({
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      headers: loggableHeaders(request.headers),
      authentication: {
        signatureProvided: request.headers.has("x-webhook-signature"),
        timestampProvided: request.headers.has("x-webhook-timestamp"),
        tokenProvided: webhookToken(request.headers) !== "",
      },
      body: loggableBody(rawBody.toString("utf8")),
    }));
    const payload = parseJson(rawBody);
    const providerBatch = providerBatchSchema.safeParse(payload);
    if (providerBatch.success) {
      const response = await handleProviderBatch(providerBatch.data, rawBody, request.headers, config);
      return logWebhookResponse(response, startedAt);
    }

    const { md5 } = z.object({ md5: md5Schema }).parse(payload);
    const transaction = requireTransaction(md5);
    authenticateCallback(transaction, rawBody, request.headers, config);
    const input = callbackSchema.parse(payload);
    if (transaction.mode !== config.mode) throw new ApiError(409, "The callback does not match the current payment environment.");
    const response = json({ received: true, data: applyResult(input.md5, input, "webhook") });
    return logWebhookResponse(response, startedAt);
  } catch (error) {
    if (!rawBody) {
      console.error("KHQR_WEBHOOK_REQUEST_ERROR", JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        contentType: request.headers.get("content-type"),
        headers: loggableHeaders(request.headers),
        error: error instanceof Error ? error.message : "Unknown request error",
      }));
    }
    return logWebhookResponse(apiError(error), startedAt);
  }
}
