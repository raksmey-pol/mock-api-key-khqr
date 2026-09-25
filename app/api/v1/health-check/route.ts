import { getConfig, POLL_INTERVAL_MS } from "@/lib/server/config";
import { json } from "@/lib/server/http";
import { database } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getConfig();
    database().prepare("SELECT 1").get();
    const pollingAvailable = config.mode === "mock" || Boolean(config.token);
    return json({
      status: "ok", service: "mekong-khqr-store", timestamp: new Date().toISOString(),
      mode: config.mode, storage: "sqlite", merchantName: config.merchantName,
      methods: pollingAvailable ? ["webhook", "polling"] : ["webhook"],
      webhookSignatureModes: config.webhookSecret ? ["signed", "token", "unsigned"] : ["unsigned"],
      defaultWebhookSignatureMode: config.webhookSignatureMode,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  } catch {
    return json({ status: "error", error: "Configuration or transaction storage is unavailable.", timestamp: new Date().toISOString() }, 503);
  }
}
