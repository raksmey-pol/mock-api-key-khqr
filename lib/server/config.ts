import { z } from "zod";
import { ApiError } from "./http";
import type { CheckoutProvider } from "../types";

const configSchema = z.object({
  mode: z.enum(["mock", "bakong"]),
  accountId: z.string().min(3).max(32).regex(/^[^\s@]+@[^\s@]+$/),
  merchantName: z.string().min(1).max(25).regex(/^[\x20-\x7E]+$/),
  merchantCity: z.string().min(1).max(15).regex(/^[\x20-\x7E]+$/),
  merchantId: z.string().max(32),
  acquiringBank: z.string().max(32),
  baseUrl: z.url(),
  token: z.string(),
  webhookSecret: z.string(),
  webhookSignatureMode: z.enum(["signed", "token", "unsigned"]),
  expirationMinutes: z.coerce.number().int().min(1).max(10),
  bakongMerchantToken: z.string().max(128),
  bakongCheckoutApiUrl: z.string().max(256),
});

const DEMO_MERCHANT_TOKEN = "mbk.mekong-mock-merchant";

export function getConfig() {
  const mode = process.env.PAYMENT_MODE ?? "mock";
  const config = configSchema.parse({
    mode,
    accountId: mode === "mock" ? "mock_store@devb" : process.env.BAKONG_ACCOUNT_ID ?? "",
    merchantName: process.env.KHQR_MERCHANT_NAME ?? "Mekong Store",
    merchantCity: process.env.KHQR_MERCHANT_CITY ?? "Phnom Penh",
    merchantId: mode === "mock" ? "" : process.env.KHQR_MERCHANT_ID ?? "",
    acquiringBank: mode === "mock" ? "" : process.env.KHQR_ACQUIRING_BANK ?? "",
    baseUrl: process.env.BAKONG_API_URL ?? "https://api-bakong.nbc.gov.kh",
    token: process.env.BAKONG_TOKEN ?? "",
    webhookSecret: process.env.WEBHOOK_SECRET ?? "",
    webhookSignatureMode: process.env.WEBHOOK_SIGNATURE_MODE || (process.env.WEBHOOK_SECRET ? "signed" : "unsigned"),
    expirationMinutes: process.env.KHQR_EXPIRATION_MINUTES ?? 5,
    bakongMerchantToken: process.env.BAKONG_MERCHANT_TOKEN ?? "",
    bakongCheckoutApiUrl: process.env.BAKONG_CHECKOUT_API_URL ?? "",
  });
  if (config.merchantId && !config.acquiringBank) throw new ApiError(503, "KHQR_ACQUIRING_BANK is required with a merchant ID.");
  if (config.webhookSignatureMode !== "unsigned" && !config.webhookSecret) {
    throw new ApiError(503, "WEBHOOK_SECRET is required for signed or token webhook authentication.");
  }
  if (Boolean(config.bakongMerchantToken) !== Boolean(config.bakongCheckoutApiUrl)) {
    throw new ApiError(503, "BAKONG_CHECKOUT_API_URL and BAKONG_MERCHANT_TOKEN must be configured together for the real checkout page.");
  }
  if (config.bakongCheckoutApiUrl && !URL.canParse(config.bakongCheckoutApiUrl)) {
    throw new ApiError(503, "BAKONG_CHECKOUT_API_URL must be a valid URL.");
  }
  return { ...config, checkoutProvider: checkoutProvider(config) };
}

function checkoutProvider(config: { bakongMerchantToken: string; bakongCheckoutApiUrl: string }): CheckoutProvider {
  return config.bakongMerchantToken && config.bakongCheckoutApiUrl ? "bakong" : "mock";
}

// The merchant bearer credential required by the checkout Open API, both for
// the emulated (mock) merchant endpoints and, when configured, for real calls.
export function merchantToken(config: ReturnType<typeof getConfig>) {
  return config.bakongMerchantToken || DEMO_MERCHANT_TOKEN;
}

export const DEMO = { MERCHANT_TOKEN: DEMO_MERCHANT_TOKEN };
export const POLL_INTERVAL_MS = 3000;
