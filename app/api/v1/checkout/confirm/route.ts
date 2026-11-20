import { z } from "zod";
import { browserTransaction, confirmRemoteCheckoutSession } from "@/lib/server/checkout";
import { apiError, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

const schema = z.object({ sessionId: z.string().min(1).max(128) }).strict();

// POST /api/v1/checkout/confirm — the browser calls this after checkout.js
// reports success (and again while the status is PENDING). The server never
// trusts the browser's claim: it re-reads the session and settles only a
// verified SUCCESS whose amount, currency, and billNo match the stored order.
export async function POST(request: Request) {
  try {
    const { sessionId } = schema.parse(await readJson(request));
    const result = await confirmRemoteCheckoutSession(sessionId, 60);
    return json({
      data: result.transaction ? browserTransaction(result.transaction) : null,
      session_status: result.status,
    });
  } catch (error) {
    return apiError(error);
  }
}
