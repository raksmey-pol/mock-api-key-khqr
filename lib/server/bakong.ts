import { z } from "zod";
import type { ProviderResult, Transaction } from "../types";
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
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/check_transaction_by_md5`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ md5: transaction.md5 }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(502, "Bakong is unreachable or timed out. Try checking again.");
  }
  if (!response.ok) throw new ApiError(502, `Bakong returned HTTP ${response.status}. Check your API configuration.`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError(502, "Bakong returned a non-JSON response."); }
  return parseBakongResponse(body);
}
