import { cancelCheckoutSession, merchantSessionView, openApiError, openApiJson, requireMerchantAuth } from "@/lib/server/checkout";

export const runtime = "nodejs";

// POST {base}/v1/checkout/sessions/{id}/cancel — cancel a pending session (section 7.4).
// Terminal sessions return 409 and a cancel never overrides a settlement.
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    requireMerchantAuth(request);
    const { sessionId } = await context.params;
    const cancelled = cancelCheckoutSession(sessionId);
    return openApiJson(merchantSessionView(cancelled));
  } catch (error) { return openApiError(error); }
}
