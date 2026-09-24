import { apiError, json } from "@/lib/server/http";
import { getTransaction, md5Schema, methodSchema, pollTransaction } from "@/lib/server/transactions";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const md5 = md5Schema.parse(query.get("md5"));
    const method = methodSchema.parse(query.get("method") ?? "polling");
    const data = method === "polling" ? await pollTransaction(md5) : getTransaction(md5);
    return json({ data, method });
  } catch (error) { return apiError(error); }
}
