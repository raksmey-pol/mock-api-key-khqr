import { z } from "zod";
import { apiError, readJson } from "@/lib/server/http";
import { md5Schema, methodSchema } from "@/lib/server/transactions";
import { simulateMockPayment } from "@/lib/server/simulate";

export const runtime = "nodejs";

const schema = z.object({ md5: md5Schema, status: z.enum(["paid", "failed"]), method: methodSchema }).strict();

export async function POST(request: Request) {
  try {
    return await simulateMockPayment(schema.parse(await readJson(request)));
  } catch (error) { return apiError(error); }
}
