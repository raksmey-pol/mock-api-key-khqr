import { randomUUID } from "node:crypto";
import type { Transaction } from "../types";

export function addEvent(
  transaction: Transaction,
  source: Transaction["events"][number]["source"],
  message: string,
) {
  const now = new Date().toISOString();
  transaction.updatedAt = now;
  transaction.events = [...transaction.events, { id: randomUUID(), at: now, source, message }].slice(-30);
  return transaction;
}

// Map a hosted checkout session's forward-only status onto the local order.
export type CheckoutOutcome = "paid" | "failed" | "expired";

export function checkoutStatusToResult(status: string): CheckoutOutcome | null {
  if (status === "SUCCESS") return "paid";
  if (status === "FAILED" || status === "TIMEOUT" || status === "CANCELLED") return "failed";
  if (status === "EXPIRED") return "expired";
  return null;
}

// Settlement driven by a hosted checkout session. The browser page and its
// messages are never the source of truth; this write verifies the order fields
// (integration guide 7.2) before either status change.
export function applyRemoteResult(transaction: Transaction, remote: {
  status: string;
  amount: number;
  currency: Transaction["currency"];
  billNo: string;
  sessionId: string;
  paymentAt?: number;
}): Transaction {
  const outcome = checkoutStatusToResult(remote.status);
  if (!outcome) return transaction; // CREATED/SCANNED stay pending.
  if (transaction.status !== "pending") return transaction; // Replays are no-ops.
  if (remote.billNo !== transaction.orderNumber || remote.amount !== transaction.amount || remote.currency !== transaction.currency) {
    if (!transaction.events.some((event) => event.message.startsWith("The checkout page session"))) {
      addEvent(transaction, "system", "The checkout page session returned fields that do not match the order. Payment was not recorded.");
    }
    return transaction;
  }
  transaction.status = outcome;
  if (outcome === "paid") {
    const paymentAt = remote.paymentAt ? new Date(remote.paymentAt * 1000) : new Date();
    transaction.paidAt = paymentAt.toISOString();
    transaction.providerReference = remote.sessionId;
    return addEvent(transaction, "system", `Payment confirmed by checkout page session at ${transaction.paidAt}.`);
  }
  transaction.providerReference = remote.sessionId;
  return addEvent(transaction, "system", `Checkout page session ended with ${remote.status}.`);
}

// Cancelling frees the pending order without fulfilling it.
export function applyCancellation(transaction: Transaction): Transaction {
  if (transaction.status !== "pending") return transaction;
  transaction.status = "failed";
  transaction.providerReference = null;
  return addEvent(transaction, "system", "Checkout page session cancelled. The order was not fulfilled.");
}

// Late-settlement note recorded on the linked order when the session already
// reached a terminal status (integration guide section 3.1).
export function applyLateSettlement(transaction: Transaction): Transaction {
  if (!transaction.events.some((event) => event.message.startsWith("Late payment after"))) {
    addEvent(transaction, "system", "Late payment after the checkout page session reached a terminal status. Record reversal evidence and investigate before fulfilling.");
  }
  return transaction;
}
