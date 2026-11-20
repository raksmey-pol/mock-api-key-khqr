import { z } from "zod";
import type { ProviderResult, Transaction } from "../types";
import { readRemoteCheckoutSession, requireRemoteTerminalFields } from "./checkout";
import { getConfig } from "./config";
import { ApiError } from "./http";
import { readMockPayment } from "./store";

const bakongResponse = z.object({
  responseCode: z.number(),
  responseMessage: z.string().nullish(),
  errorCode: z.number().nullish(),
  data: z.unknown().nullish(),
});

const paymentData = z.object({
  hash: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["USD", "KHR"]),
});

export function parseBakongResponse(body: unknown): ProviderResult {
  const parsed = bakongResponse.safeParse(body);
  if (!parsed.success) throw new ApiError(502, "Bakong returned an invalid response.");
  const response = parsed.data;
  if (response.responseCode === 0) {
    const payment = paymentData.safeParse(response.data);
    if (!payment.success) throw new ApiError(502, "Bakong returned invalid payment details.");
    return { status: "paid", ...payment.data, transactionId: payment.data.hash };
  }
  // A missing transfer is pending, not a failed payment. Other API errors must
  // be surfaced instead of silently being treated as unpaid transactions.
  const message = response.responseMessage ?? "";
  if (response.responseCode === 1 && /transaction (?:could not be|not) found/i.test(message)) return { status: "pending" };
  if (response.responseCode === 1 && /^transaction failed\.?$/i.test(message.trim())) return { status: "failed" };
  throw new ApiError(502, "Bakong could not check this payment. Check the API token and provider availability.");
}

export async function checkProvider(transaction: Transaction): Promise<ProviderResult> {
  if (transaction.mode === "mock") return readMockPayment(transaction.md5);
  const config = getConfig();
  if (config.mode !== "bakong") throw new ApiError(409, "Switch to Bakong mode to check this transaction.");
  // Checkout page orders settle through the hosted checkout session rather
  // than the MD5 transaction API: their QR belongs to the session, not a
  // locally generated string. The server-side waiter covers webhook orders.
  if (transaction.checkoutSessionId && config.checkoutProvider === "bakong") {
    const remote = await readRemoteCheckoutSession(transaction.checkoutSessionId, 10);
    // A long-poll that ends at its window may return only { session_id,
    // status: "PENDING" }; verify fields whenever the provider returned them.
    if (
      remote.billNo !== undefined &&
      remote.amount !== undefined &&
      remote.currency !== undefined &&
      (remote.billNo !== transaction.orderNumber ||
        remote.amount !== transaction.amount ||
        remote.currency !== transaction.currency)
    ) {
      throw new ApiError(409, "The checkout page session returned fields that do not match the order.");
    }
    // Endpoint 6 belongs to the session, not the local MD5, so a SUCCESS maps
    // to a full receipt the storefront's single write path records it with.
    if (remote.status === "SUCCESS") {
      const verified = requireRemoteTerminalFields(remote);
      return {
        status: "paid",
        amount: verified.amount,
        currency: verified.currency,
        toAccountId: transaction.accountId,
        transactionId: verified.session_id,
      };
    }
    if (remote.status === "FAILED" || remote.status === "TIMEOUT" || remote.status === "CANCELLED") {
      return { status: "failed" };
    }
    return { status: "pending" };
  }
  if (!config.token) throw new ApiError(503, "BAKONG_TOKEN is required for Bakong MD5 polling.");
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/check_transaction_by_md5`, {
      method: "POST",
      headers: { "x-api-key": config.token, "Content-Type": "application/json" },
      body: JSON.stringify({ md5: transaction.md5 }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(502, "Bakong is unreachable or timed out. Try checking again.");
  }
  if (response.status === 401) throw new ApiError(502, "Bakong rejected the BAKONG_TOKEN API key. Use a valid, unexpired key for the configured BAKONG_API_URL.");
  if (!response.ok) throw new ApiError(502, `Bakong returned HTTP ${response.status}. Check your API configuration.`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError(502, "Bakong returned a non-JSON response."); }
  return parseBakongResponse(body);
}
