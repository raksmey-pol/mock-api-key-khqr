import { getConfig, POLL_INTERVAL_MS } from "@/lib/server/config";
import { json } from "@/lib/server/http";
import { database } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getConfig();
    database().prepare("SELECT 1").get();
    return json({
      status: "ok", service: "mekong-khqr-store", timestamp: new Date().toISOString(),
      mode: config.mode, storage: "sqlite", merchantName: config.merchantName,
      methods: config.mode === "mock" || config.webhookSecret ? ["webhook", "polling"] : ["polling"],
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  } catch {
    return json({ status: "error", error: "Configuration or transaction storage is unavailable.", timestamp: new Date().toISOString() }, 503);
  }
}
