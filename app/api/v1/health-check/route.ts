import { getConfig, POLL_INTERVAL_MS } from "@/lib/server/config";
import { json } from "@/lib/server/http";
import { database } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getConfig();
    database().prepare("SELECT 1").get();
    const pollingAvailable = config.mode === "mock" || Boolean(config.token);
    // The hosted checkout page is always emulated in mock deployments; when
    // both real-provider environment variables are present the sessions are
    // minted through the configured Bakong checkout Open API instead.
    const checkoutPage = config.bakongMerchantToken && config.bakongCheckoutApiUrl
      ? {
          available: true,
          provider: "bakong" as const,
          checkoutHost: config.checkoutHost || null,
          popupAvailable: Boolean(config.checkoutHost),
        }
      : {
          available: true,
          provider: "mock" as const,
          checkoutHost: config.checkoutHost || null,
          popupAvailable: false,
        };
    return json({
      status: "ok", service: "mekong-khqr-store", timestamp: new Date().toISOString(),
      mode: config.mode, storage: "sqlite", merchantName: config.merchantName,
      methods: pollingAvailable ? ["webhook", "polling"] : ["webhook"],
      webhookSignatureModes: config.webhookSecret ? ["signed", "token", "unsigned"] : ["unsigned"],
      defaultWebhookSignatureMode: config.webhookSignatureMode,
      pollIntervalMs: POLL_INTERVAL_MS,
      checkoutPage,
    });
  } catch {
    return json({ status: "error", error: "Configuration or transaction storage is unavailable.", timestamp: new Date().toISOString() }, 503);
  }
}
