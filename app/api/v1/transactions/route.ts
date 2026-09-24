import { getConfig } from "@/lib/server/config";
import { apiError, json, readJson } from "@/lib/server/http";
import { recentTransactions } from "@/lib/server/store";
import { createTransaction, getTransaction } from "@/lib/server/transactions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { return json({ data: await createTransaction(await readJson(request)) }, 201); }
  catch (error) { return apiError(error); }
}

export async function GET() {
  try {
    const config = getConfig();
    const data = recentTransactions(config.mode)
      .map((transaction) => getTransaction(transaction.md5));
    return json({ data });
  } catch (error) { return apiError(error); }
}
