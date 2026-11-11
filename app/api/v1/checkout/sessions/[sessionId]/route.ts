import { readMerchantSession, waitForMerchantSession, openApiError, openApiJson, requireMerchantAuth } from "@/lib/server/checkout";
import { z } from "zod";
import { ApiError } from "@/lib/server/http";

export const runtime = "nodejs";

// GET {base}/v1/checkout/sessions/{id} — read or long-poll a session (section 7.1).
// `wait=true` holds the request until a terminal transition or the `w` window
// (1 to 90 seconds, default 90) elapses.
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    requireMerchantAuth(request);
    const { sessionId } = await context.params;
    const query = new URL(request.url).searchParams;
    const wait = query.get("wait");
    if (wait !== null && wait !== "true" && wait !== "false" && wait !== "1" && wait !== "0") {
      throw new ApiError(400, "wait must be true or false.");
    }
    const windowSchema = z.coerce.number().int().min(1).max(90).default(90);
    const window = windowSchema.safeParse(query.get("w") ?? undefined);
    if (!window.success) throw new ApiError(400, "w must be an integer from 1 to 90.");
    const data = wait === "true" || wait === "1"
      ? await waitForMerchantSession(sessionId, window.data)
      : readMerchantSession(sessionId);
    return openApiJson(data);
  } catch (error) { return openApiError(error); }
}
