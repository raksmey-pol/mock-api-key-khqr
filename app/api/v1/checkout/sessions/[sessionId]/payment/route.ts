import { enforcePaymentRateLimit, paymentPayload } from "@/lib/server/checkout";
import { ApiError, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET {base}/v1/checkout/sessions/{token}/payment — the hosted page's payment
// payload (integration guide section 8). The signed token is the credential;
// md5 and session_id are never exposed here.
export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId: token } = await context.params;
    enforcePaymentRateLimit(token);
    return json(await paymentPayload(token));
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      return Response.json({ error: error.message }, {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "2" },
      });
    }
    return json({ error: error instanceof ApiError ? error.message : "The payment payload could not be read." },
      error instanceof ApiError ? error.status : 500);
  }
}
