import { sessionForSimulation } from "@/lib/server/checkout";
import { apiError, json, readJson } from "@/lib/server/http";
import { simulateMockPayment } from "@/lib/server/simulate";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({ status: z.enum(["paid", "failed"]) }).strict();

// POST {base}/v1/checkout/sessions/{token}/simulate — mock-only demo control
// rendered on the hosted checkout page. It runs the exact simulation core used
// by the storefront, honouring the order's saved listener method.
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId: token } = await context.params;
    const { status } = schema.parse(await readJson(request));
    const { session } = sessionForSimulation(token);
    return await simulateMockPayment({ md5: session.md5, status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json({ error: error.issues.map((issue) => issue.message).join("; ") }, 400);
    }
    return apiError(error);
  }
}
