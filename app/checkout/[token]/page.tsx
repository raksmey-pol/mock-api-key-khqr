import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfig } from "@/lib/server/config";
import { paymentPayload, readCheckoutSessionByToken } from "@/lib/server/checkout";
import { readTransaction } from "@/lib/server/store";
import { CheckoutPageClient } from "@/components/checkout-page-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hosted checkout page. The signed checkout token is the credential; the page
// polls endpoint #5, posts status accelerators to the verified merchant origin
// inside an iframe, and completes with the success redirect in full-page mode.
export const metadata: Metadata = {
  title: "Bakong checkout — Mekong",
  robots: { index: false },
};

export default async function CheckoutPage(props: PageProps<"/checkout/[token]">) {
  const { token } = await props.params;
  const session = readCheckoutSessionByToken(token);
  if (!session) notFound();
  const payload = await paymentPayload(token);
  const transaction = session.md5 ? readTransaction(session.md5) : null;
  return (
    <main className="hosted-page">
      <CheckoutPageClient
        token={token}
        payload={payload}
        session={{ sessionId: session.sessionId, expiry: session.expiry, status: session.status }}
        demo={getConfig().mode === "mock" && Boolean(transaction)}
      />
    </main>
  );
}
