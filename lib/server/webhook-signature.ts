import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./http";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

function digest(body: string | Uint8Array, secret: string, timestamp: string) {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
}

export function signWebhookBody(
  body: string | Uint8Array,
  secret: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  if (!secret) throw new ApiError(503, "WEBHOOK_SECRET is required for signed webhooks.");
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": `sha256=${digest(body, secret, timestamp).toString("hex")}`,
  };
}

export function verifyWebhookSignature(body: Uint8Array, headers: Headers, secret: string) {
  if (!secret) throw new ApiError(503, "WEBHOOK_SECRET is required for this signed webhook.");
  const timestamp = headers.get("x-webhook-timestamp") ?? "";
  const signature = headers.get("x-webhook-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    throw new ApiError(401, "Signed webhooks require valid x-webhook-timestamp and x-webhook-signature headers.");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new ApiError(401, "Webhook timestamp must be within 5 minutes of server time.");
  }
  const received = Buffer.from(signature.slice(7), "hex");
  const expected = digest(body, secret, timestamp);
  if (!timingSafeEqual(received, expected)) throw new ApiError(401, "Invalid webhook signature.");
}
