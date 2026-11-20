import { getConfig } from "@/lib/server/config";
import { apiError, json, readJson, requestOrigin } from "@/lib/server/http";
import { recentTransactions } from "@/lib/server/store";
import { createTransaction, getTransaction } from "@/lib/server/transactions";
import { isRealCheckoutProvider, browserTransaction, runCheckoutPageWaiter } from "@/lib/server/checkout";
import { after } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const transaction = await createTransaction(await readJson(request), { origin: requestOrigin(request) });
    // Real hosted checkout sessions settle through a durable waiter: the
    // browser page and its messages are never the source of truth. Emulated
    // sessions settle through the storefront's own listeners.
    if (transaction.checkoutSessionId && isRealCheckoutProvider()) {
      try {
        after(async () => {
          await runCheckoutPageWaiter({ sessionId: transaction.checkoutSessionId!, md5: transaction.md5 });
        });
      } catch {
        console.warn("KHQR_CHECKOUT_WAITER", "Could not schedule the checkout page waiter for this session.");
      }
    }
    return json({ data: browserTransaction(transaction) }, 201);
  } catch (error) { return apiError(error); }
}

export async function GET() {
  try {
    const config = getConfig();
    const data = recentTransactions(config.mode)
      .map((transaction) => browserTransaction(getTransaction(transaction.md5)));
    return json({ data });
  } catch (error) { return apiError(error); }
}
