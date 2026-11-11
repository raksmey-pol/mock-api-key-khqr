import type { Metadata } from "next";
import { getTransactionByOrderNumber } from "@/lib/server/transactions";
import { CheckoutReturnClient } from "@/components/checkout-return-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payment status — Mekong",
  robots: { index: false },
};

// The merchant return page for hosted-checkout full-page mode. The redirect's
// query string is unsigned and never fulfills orders: this page reads the local
// order state, keeps listening for the backend's confirmation, and is safe for
// refreshes, double opens, and early returns (integration guide 6.3).
export default async function CheckoutReturnPage(props: {
  searchParams: Promise<{ bill?: string; status?: string }>;
}) {
  const { bill, status } = await props.searchParams;
  const billNo = (bill ?? "").trim();
  let transaction = null;
  let lookupError: string | null = null;
  if (billNo) {
    try {
      transaction = getTransactionByOrderNumber(billNo);
    } catch {
      lookupError = "We could not find this order. Keep this page open; the payment may still be settling.";
    }
  }
  // The redirect's `status` parameter is unsigned: the page never fulfils from
  // it. It is echoed only to explain why verification continues in the backend.
  const reportedStatus = status?.toUpperCase() === "SUCCESS" ? "SUCCESS" : null;
  return (
    <main className="hosted-page">
      <CheckoutReturnClient
        bill={billNo}
        md5={transaction?.md5 ?? null}
        method={transaction?.method ?? null}
        checkoutUrl={transaction?.checkoutUrl ?? null}
        reportedStatus={reportedStatus}
        invalid={!billNo || Boolean(lookupError)}
      />
    </main>
  );
}
