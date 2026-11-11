"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCheck, Clock3, Radio, X } from "lucide-react";
import type { StatusMethod, Transaction } from "@/lib/types";

type Props = {
  bill: string;
  md5: string | null;
  method: StatusMethod | null;
  checkoutUrl: string | null;
  reportedStatus: "SUCCESS" | null;
  invalid: boolean;
};

// Keeps the return page aligned with the storefront listeners: webhook orders
// stream local status changes, polling orders actively query the provider.
export function CheckoutReturnClient({ bill, md5, method, checkoutUrl, reportedStatus, invalid }: Props) {
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [error, setError] = useState("");
  const pending = transaction?.status === "pending" || (invalid === false && !transaction);

  useEffect(() => {
    if (!md5 || !method) return;
    if (method === "webhook") {
      const source = new EventSource(`/api/v1/transactions/events?md5=${md5}`);
      source.addEventListener("transaction", (event: MessageEvent) => {
        setTransaction(JSON.parse(event.data) as Transaction);
      });
      source.onerror = () => source.close();
      return () => source.close();
    }
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/transactions/search?md5=${md5}&method=polling`, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not check payment.");
        if (!stopped) setTransaction(result.data as Transaction);
        if ((result.data as Transaction).status !== "pending") return;
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : "Could not check payment.");
      }
      if (!stopped) timeout = setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timeout); };
  }, [md5, method]);

  if (invalid) {
    return (
      <div className="return-card return-card--error">
        <div className="return-icon"><X size={34} /></div>
        <h1>This order is not available.</h1>
        <p>{bill ? "We could not find an order for this bill number. Keep the page open while the payment settles." : "This return link is missing its bill number."}</p>
        <Link className="primary-button" href="/">Back to the store<ArrowRight size={15} /></Link>
      </div>
    );
  }

  const status = transaction?.status ?? "pending";
  return (
    <div className="return-card">
      <div className={`
        return-icon
        ${status === "paid" ? "return-icon--paid" : status === "failed" ? "return-icon--failed" : ""}
      `}>
        {status === "paid" ? <CheckCheck size={34} /> : status === "failed" ? <X size={34} /> : <Radio size={34} />}
      </div>
      <h1>
        {status === "paid"
          ? "A little good, on its way."
          : status === "failed"
            ? "That payment did not go through."
            : status === "expired"
              ? "The checkout window closed."
              : "Confirming your payment…"}
      </h1>
      <p className="return-bill">
        Order <code>{bill}</code>
      </p>
      <p>
        {status === "paid"
          ? "Payment received. Thank you for shopping with Mekong."
          : status === "failed"
            ? "You can try a new payment from the store."
            : status === "expired"
              ? "Create a new checkout at the store. A verified late payment can still be reconciled."
              : "Your hosted checkout completed. The store verifies the payment with its backend before updating this page. You can refresh or close the page; this state is safe to revisit."}
      </p>
      {reportedStatus && status !== "paid" && (
        <p className="return-note">
          The checkout page reported <code>{reportedStatus}</code>; the store only fulfils after its own backend verification.
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">{error}</p>
      )}
      {pending && (
        <p className="return-waiting"><Clock3 size={14} /> Checking with the store…</p>
      )}
      <Link className="primary-button" href="/">Back to the store<ArrowRight size={15} /></Link>
      {pending && checkoutUrl && (
        <a className="text-button" href={checkoutUrl}>Reopen the checkout page</a>
      )}
    </div>
  );
}
