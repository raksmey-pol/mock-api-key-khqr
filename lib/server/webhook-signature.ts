import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./http";

const TIMESTAMP_TOLERANCE_SECONDS = 300;
const HEX_SIGNATURE = /^[a-f0-9]{64}$/i;
const UNIX_SECONDS = /^\d{1,12}$/;

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

type SignatureCandidate = { timestamp: string; signatures: string[] };

// Bakong and Stripe-compatible senders put `t=<unix>,v1=<hex>` in `webhook-signature`.
function stripeCandidate(header: string): SignatureCandidate | null {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && UNIX_SECONDS.test(value)) timestamp = value;
    else if (key === "v1" && HEX_SIGNATURE.test(value)) signatures.push(value);
  }
  return timestamp && signatures.length ? { timestamp, signatures } : null;
}

function signatureCandidates(headers: Headers): SignatureCandidate[] {
  const candidates: SignatureCandidate[] = [];
  for (const header of [headers.get("webhook-signature"), headers.get("x-webhook-signature")]) {
    if (!header) continue;
    const candidate = stripeCandidate(header);
    if (candidate) candidates.push(candidate);
  }
  const timestamp = headers.get("x-webhook-timestamp") ?? "";
  const signature = /^sha256=([a-f0-9]{64})$/i.exec(headers.get("x-webhook-signature") ?? "");
  if (UNIX_SECONDS.test(timestamp) && signature) candidates.push({ timestamp, signatures: [signature[1]] });
  return candidates;
}

export function verifyWebhookSignature(body: Uint8Array, headers: Headers, secret: string) {
  if (!secret) throw new ApiError(503, "WEBHOOK_SECRET is required for this signed webhook.");
  const candidates = signatureCandidates(headers);
  if (!candidates.length) {
    throw new ApiError(401, "Signed webhooks require webhook-signature: t=<unix>,v1=<hex> or x-webhook-timestamp with x-webhook-signature: sha256=<hex>.");
  }
  const now = Math.floor(Date.now() / 1000);
  let stale = false;
  for (const candidate of candidates) {
    if (Math.abs(now - Number(candidate.timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
      stale = true;
      continue;
    }
    const expected = digest(body, secret, candidate.timestamp);
    for (const signature of candidate.signatures) {
      const received = Buffer.from(signature, "hex");
      if (received.length === expected.length && timingSafeEqual(received, expected)) return;
    }
  }
  if (stale) throw new ApiError(401, "Webhook timestamp must be within 5 minutes of server time.");
  throw new ApiError(401, "Invalid webhook signature.");
}
