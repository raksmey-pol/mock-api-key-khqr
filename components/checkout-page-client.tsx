"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, Clock3, ExternalLink, LoaderCircle, Terminal, X } from "lucide-react";
import type { CheckoutPagePaymentPayload, CheckoutSessionStatus } from "@/lib/types";

type Props = {
  token: string;
  payload: CheckoutPagePaymentPayload;
  session: { sessionId: string; expiry: number; status: CheckoutSessionStatus };
  demo: boolean;
};

const TERMINAL: CheckoutSessionStatus[] = ["SUCCESS", "FAILED", "TIMEOUT", "EXPIRED", "CANCELLED"];

// Substitutes the {BILL_NO} placeholder and appends the status parameter
// exactly per the integration guide's full-page redirect contract (section 6.3).
function successRedirect(successUrl: string, billNo: string) {
  const base = successUrl.replace("{BILL_NO}", billNo).replace("{bill_no}", billNo);
  return base + (base.includes("?") ? "&" : "?") + "status=SUCCESS";
}

export function CheckoutPageClient({ token, payload, session, demo }: Props) {
  const [payment, setPayment] = useState<CheckoutPagePaymentPayload>(payload);
  const [embedded, setEmbedded] = useState(false);
  const [simulateBusy, setSimulateBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const postedStatus = useRef<CheckoutSessionStatus | null>(null);
  const countdown = payment.expiry;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    // Detect the embedding after hydration so SSR markup never contradicts it.
    queueMicrotask(() => {
      if (cancelled) return;
      try { setEmbedded(window.self !== window.top); } catch { setEmbedded(true); }
    });
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll the sanitized payment payload (endpoint #5). The hosted page owns the
  // loop and honours the endpoint's per-token rate limit with Retry-After.
  useEffect(() => {
    if (TERMINAL.includes(payment.status)) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let retryInMs = 2000;
      try {
        const response = await fetch(`/api/v1/checkout/sessions/${encodeURIComponent(token)}/payment`, { cache: "no-store" });
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After") ?? "2");
          retryInMs = (Number.isFinite(retryAfter) ? Math.max(retryAfter, 2) : 2) * 1000;
        } else if (response.ok) {
          const next = (await response.json()) as CheckoutPagePaymentPayload;
          if (!stopped) setPayment(next);
          if (TERMINAL.includes(next.status)) return;
        }
        // Other statuses are retried; the page displays what it knows so far.
      } catch { /* transient network errors keep the loop alive */ }
      if (!stopped) timeout = setTimeout(poll, retryInMs);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timeout); };
  }, [token, payment.status]);

  // Post the status accelerator to the verified merchant origin. Backend
  // confirmation stays the only source of truth for fulfilment.
  useEffect(() => {
    if (postedStatus.current === payment.status) return;
    postedStatus.current = payment.status;
    const type = payment.status === "SUCCESS"
      ? "PAYMENT_SUCCESS"
      : TERMINAL.includes(payment.status)
        ? "SESSION_EXPIRED"
        : payment.status === "SCANNED"
          ? "SCANNED"
          : null;
    if (!type || !embedded) return;
    try {
      window.parent?.postMessage({ type, sessionId: session.sessionId }, payment.merchant_origin);
    } catch { /* the parent may already have navigated away */ }
  }, [payment, embedded, session.sessionId]);

  // Full-page redirect mode: show a short paid confirmation, then redirect
  // (section 6.3). Without a success_url the page keeps the confirmation.
  useEffect(() => {
    if (embedded || payment.status !== "SUCCESS" || !payment.success_url) return;
    const timeout = setTimeout(() => {
      window.location.assign(successRedirect(payment.success_url!, payment.bill_display));
    }, 1500);
    return () => clearTimeout(timeout);
  }, [embedded, payment.status, payment.success_url, payment.bill_display]);

  const secondsLeft = Math.max(0, countdown - Math.floor(now / 1000));
  const expired = secondsLeft === 0 || TERMINAL.includes(payment.status);
  const pending = payment.status === "CREATED" || payment.status === "SCANNED";

  async function simulate(status: "paid" | "failed") {
    if (simulateBusy || queued) return;
    setSimulateBusy(true);
    try {
      const response = await fetch(`/api/v1/checkout/sessions/${encodeURIComponent(token)}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (response.ok) setQueued(true);
    } catch { /* surfaced through the next poll or terminal view */ } finally {
      setSimulateBusy(false);
    }
  }

  const statusLabel: Record<CheckoutSessionStatus, string> = {
    CREATED: "Awaiting payment",
    SCANNED: "Payment detected",
    SUCCESS: "Paid",
    FAILED: "Failed",
    TIMEOUT: "Timed out",
    EXPIRED: "Expired",
    CANCELLED: "Cancelled",
  };

  return (
    <div className="hosted-shell">
      <div className="khqr-card hosted-card">
        <div className="khqr-banner">
          {payment.status === "SUCCESS" ? "PAID" : "KHQR"}<span>{payment.currency === "KHR" ? "៛" : "$"}</span>
        </div>
        <div className="khqr-recipient">
          <span>{payment.merchant_name}</span>
          <strong>
            {payment.currency === "KHR"
              ? `${payment.amount.toLocaleString()} ៛`
              : `$${payment.amount.toFixed(2)}`}
          </strong>
        </div>
        <div className="hosted-bill">
          <span>BILL</span>
          <code>{payment.bill_display}</code>
        </div>
        {pending ? (
          <div className="qr-image">
            {payment.khqr_image ? (
              <Image
                src={payment.khqr_image}
                width={250}
                height={250}
                unoptimized
                alt={`KHQR payment for ${payment.merchant_name}`}
              />
            ) : (
              <div className="hosted-qr-fallback" aria-hidden="true" />
            )}
          </div>
        ) : (
          <div className={`payment-result result-${payment.status === "SUCCESS" ? "paid" : "failed"}`}>
            <div>
              {payment.status === "SUCCESS" ? <CheckCheck size={40} /> : <X size={40} />}
            </div>
            <strong>
              {payment.currency === "KHR"
                ? `${payment.amount.toLocaleString()} ៛`
                : `$${payment.amount.toFixed(2)}`}
            </strong>
            <span className={`status-badge status-${payment.status === "SUCCESS" ? "paid" : "failed"}`}>
              <span />
              {statusLabel[payment.status]}
            </span>
          </div>
        )}
        <div className="khqr-footer">
          {pending
            ? (secondsLeft
              ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
              : "Payment window expired")
            : payment.status === "SUCCESS"
              ? embedded
                ? "CONFIRMED · RETURNING TO THE STORE"
                : "PAYMENT COMPLETE"
              : "THIS CHECKOUT IS CLOSED"}
        </div>
      </div>

      <p className="hosted-hint">
        {pending
          ? "Scan with Bakong or any banking app that supports KHQR."
          : payment.status === "SUCCESS"
            ? (payment.success_url && !embedded
              ? "Taking you back to the store…"
              : "You can close this page; the store confirms the payment with its backend.")
            : "This checkout page closed. Create a new payment at the store."}
      </p>

      {demo && pending && (
        <div className="simulator hosted-simulator">
          <div>
            <Terminal size={15} />
            <strong>Payment simulator</strong>
            <span>MOCK</span>
          </div>
          <p>
            Demo pages settle without a banking app. The store still confirms the
            result through its own backend.
          </p>
          <button className="primary-button" disabled={simulateBusy || queued} onClick={() => void simulate("paid")}>
            {simulateBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            {queued && pending ? "Result sent · waiting for update" : "Simulate successful payment"}
          </button>
          <button className="text-button" disabled={simulateBusy || queued} onClick={() => void simulate("failed")}>
            Simulate a failed payment
          </button>
        </div>
      )}

      {embedded && expired && payment.status !== "SUCCESS" && (
        <p className="hosted-closed-hint">This checkout expired on the page. Check the store for a new payment.</p>
      )}

      {!embedded && payment.status !== "SUCCESS" && (
        <a className="hosted-return-link" href={payment.merchant_origin}>
          Back to the store
          <ExternalLink size={13} />
        </a>
      )}
      <span className="hosted-brand">
        <Clock3 size={12} />
        Secured by the Bakong checkout page
      </span>
    </div>
  );
}
