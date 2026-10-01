"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Leaf,
  LoaderCircle,
  Minus,
  Package,
  Pencil,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Terminal,
  Webhook,
  X,
} from "lucide-react";
import {
  formatMoney,
  priceLimits,
  priceOrder,
  products as defaultProducts,
} from "@/lib/catalog";
import type {
  CartItem,
  Currency,
  Health,
  Product,
  StatusMethod,
  Transaction,
  WebhookSignatureMode,
} from "@/lib/types";
import { ProductArt } from "./product-art";

type View = "store" | "transactions" | "guide";
const CURRENCY_STORAGE_KEY = "mekong:currency";
const WEBHOOK_SIGNATURE_STORAGE_KEY = "mekong:webhook-signature";

async function requestApi<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    signal: options?.signal ?? AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Something went wrong. Please try again.");
  return result as T;
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function StatusBadge({ status }: { status: Transaction["status"] }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {status === "paid"
        ? "Paid"
        : status === "pending"
          ? "Awaiting payment"
          : status === "failed"
            ? "Failed"
            : "Expired"}
    </span>
  );
}

function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const timeout = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
    return () => clearTimeout(timeout);
  }, [copied, failed]);
  return (
    <button
      className="copy-button"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setFailed(true);
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "Copied" : failed ? "Select to copy" : label}</span>
    </button>
  );
}

function MethodPicker({
  method,
  onChange,
  webhookAvailable = true,
  pollingAvailable = true,
}: {
  method: StatusMethod;
  onChange: (method: StatusMethod) => void;
  webhookAvailable?: boolean;
  pollingAvailable?: boolean;
}) {
  return (
    <div
      className="method-picker"
      role="group"
      aria-label="Payment status method"
    >
      <button
        aria-pressed={method === "webhook"}
        disabled={!webhookAvailable}
        onClick={() => onChange("webhook")}
      >
        <Webhook size={16} />
        Webhook
      </button>
      <button
        aria-pressed={method === "polling"}
        disabled={!pollingAvailable}
        onClick={() => onChange("polling")}
      >
        <RefreshCw size={15} />
        Polling
      </button>
    </div>
  );
}

function WebhookSignaturePicker({
  mode,
  onChange,
  secretAvailable,
}: {
  mode: WebhookSignatureMode;
  onChange: (mode: WebhookSignatureMode) => void;
  secretAvailable: boolean;
}) {
  return (
    <div className="webhook-signature-picker">
      <div className="section-label">WEBHOOK AUTHENTICATION</div>
      <div
        className="method-picker three-options"
        role="group"
        aria-label="Webhook authentication mode"
      >
        <button
          aria-pressed={mode === "signed"}
          disabled={!secretAvailable}
          onClick={() => onChange("signed")}
        >
          <ShieldCheck size={15} />
          Signed
        </button>
        <button
          aria-pressed={mode === "token"}
          disabled={!secretAvailable}
          onClick={() => onChange("token")}
        >
          <KeyRound size={15} />
          Token
        </button>
        <button
          aria-pressed={mode === "unsigned"}
          onClick={() => onChange("unsigned")}
        >
          <Webhook size={15} />
          Unsigned
        </button>
      </div>
      <p>
        {mode === "signed"
          ? "Verify an HMAC-SHA256 signature and a timestamp within 5 minutes."
          : mode === "token"
            ? "Require WEBHOOK_SECRET in the x-webhook-secret header."
            : "Accept a plain JSON callback without authentication headers."}
      </p>
      {!secretAvailable && (
        <p>
          Set <code>WEBHOOK_SECRET</code> on the server to enable signed or
          token callbacks.
        </p>
      )}
    </div>
  );
}

function WebhookPolicy({
  mode,
}: {
  mode: Transaction["webhookSignatureMode"];
}) {
  return (
    <div className="webhook-policy">
      {mode === "signed" ? (
        <ShieldCheck size={15} />
      ) : mode === "token" ? (
        <KeyRound size={15} />
      ) : (
        <Webhook size={15} />
      )}
      <div>
        <strong>
          {mode === "signed"
            ? "Signed webhook"
            : mode === "token"
              ? "Token webhook"
              : mode === "unsigned"
                ? "Unsigned webhook"
                : "Legacy webhook authentication"}
        </strong>
        <span>
          {mode === "signed"
            ? "HMAC-SHA256 · 5-minute timestamp window"
            : mode === "token"
              ? "Shared secret · x-webhook-secret header"
              : mode === "unsigned"
                ? "Plain JSON · no authentication required"
                : "Uses the original shared-secret configuration"}
        </span>
      </div>
    </div>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return (
    <span className="countdown">
      <Clock3 size={13} />
      {seconds
        ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
        : "Payment window expired"}
    </span>
  );
}

function PriceEditor({
  product,
  initialCurrency,
  onClose,
  onSaved,
}: {
  product: Product;
  initialCurrency: Currency;
  onClose: () => void;
  onSaved: (product: Product, currency: Currency) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [currency, setCurrency] = useState(initialCurrency);
  const [prices, setPrices] = useState({
    USD: String(product.price.USD),
    KHR: String(product.price.KHR),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    input.current?.select();
    return () => element?.close();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await requestApi<{ data: Product }>(
        `/api/v1/products/${encodeURIComponent(product.id)}`,
        {
          ...post({ currency, price: Number(prices[currency]) }),
          method: "PATCH",
        },
      );
      onSaved(result.data, currency);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save the product price.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="checkout-dialog price-editor"
      aria-labelledby="price-editor-title"
      onCancel={(event) => {
        if (saving) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (!saving && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-top">
        <span>
          <Pencil size={15} /> PRODUCT PRICING
        </span>
        <button
          className="icon-button"
          disabled={saving}
          onClick={onClose}
          aria-label="Close price editor"
        >
          <X size={20} />
        </button>
      </div>
      <form className="price-editor-form" onSubmit={save}>
        <h2 id="price-editor-title">Edit product price</h2>
        <p className="price-editor-product">{product.name}</p>
        <div className="price-fields">
          <label htmlFor="price-currency">
            Currency
            <select
              id="price-currency"
              value={currency}
              disabled={saving}
              onChange={(event) => {
                setCurrency(event.target.value as Currency);
                setError("");
              }}
            >
              <option value="USD">USD — US dollar</option>
              <option value="KHR">KHR — Cambodian riel</option>
            </select>
          </label>
          <label htmlFor="product-price">
            Price
            <input
              ref={input}
              id="product-price"
              type="number"
              inputMode={currency === "USD" ? "decimal" : "numeric"}
              required
              min={priceLimits[currency].min}
              max={priceLimits[currency].max}
              step={priceLimits[currency].step}
              value={prices[currency]}
              disabled={saving}
              aria-describedby="price-rules"
              onChange={(event) => {
                setPrices((current) => ({
                  ...current,
                  [currency]: event.target.value,
                }));
                setError("");
              }}
            />
          </label>
        </div>
        <p id="price-rules" className="price-editor-help">
          {currency === "USD"
            ? "Enter a positive amount with up to 2 decimal places."
            : "Enter a positive amount in whole riel."}{" "}
          USD and KHR prices are set separately.
        </p>
        <p className="price-editor-help">
          Saving updates this product’s {currency} price and switches your bag
          to {currency}.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="price-editor-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}
            {saving ? "Saving…" : "Save price"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function CheckoutDialog({
  initial,
  onClose,
  onUpdate,
  webhookAvailable,
  pollingAvailable,
}: {
  initial: Transaction;
  onClose: () => void;
  onUpdate: (transaction: Transaction) => void;
  webhookAvailable: boolean;
  pollingAvailable: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [transaction, setTransaction] = useState(initial);
  const [method, setMethod] = useState<StatusMethod>(
    initial.method === "polling" && !pollingAvailable
      ? "webhook"
      : initial.method,
  );
  const [connection, setConnection] = useState("Connecting…");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [checking, setChecking] = useState(false);
  const pending = transaction.status === "pending";

  const receive = useCallback(
    (next: Transaction) => {
      setTransaction(next);
      onUpdate(next);
    },
    [onUpdate],
  );

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    if (method === "webhook") {
      const source = new EventSource(
        `/api/v1/transactions/events?md5=${initial.md5}`,
      );
      source.onopen = () => {
        setConnection("Listening for webhook events");
        setError("");
      };
      source.addEventListener("transaction", (event: MessageEvent) => {
        const next = JSON.parse(event.data) as Transaction;
        receive(next);
        if (next.status !== "pending") source.close();
      });
      source.onerror = () => setConnection("Reconnecting to event stream…");
      return () => source.close();
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await requestApi<{ data: Transaction }>(
          `/api/v1/transactions/search?md5=${initial.md5}&method=polling`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15_000),
            ]),
          },
        );
        if (stopped) return;
        receive(result.data);
        setError("");
        setConnection(
          `Last checked ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
        );
        if (result.data.status !== "pending") return;
      } catch (error) {
        if (stopped) return;
        setError(
          error instanceof Error ? error.message : "Could not check payment.",
        );
        setConnection("Check failed · retrying in 3 seconds");
      }
      if (!stopped) timeout = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [initial.md5, method, pending, receive]);

  async function simulate(status: "paid" | "failed") {
    setBusy(true);
    setError("");
    try {
      await requestApi(
        "/api/v1/transactions/simulate",
        post({ md5: transaction.md5, status, method }),
      );
      setQueued(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Simulation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setChecking(true);
    setError("");
    try {
      const result = await requestApi<{ data: Transaction }>(
        `/api/v1/transactions/search?md5=${transaction.md5}&method=polling`,
      );
      receive(result.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Check failed.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="checkout-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="checkout-title"
    >
      <div className="dialog-top">
        <span>
          <ShieldCheck size={16} /> KHQR CHECKOUT
        </span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close checkout"
        >
          <X size={21} />
        </button>
      </div>
      <div className="checkout-content">
        <div className="payment-side">
          <span className="eyebrow">{transaction.orderNumber}</span>
          <h2 id="checkout-title">
            {transaction.status === "paid"
              ? "A little good, on its way."
              : transaction.status === "failed"
                ? "Let’s try that again."
                : transaction.status === "expired"
                  ? "Time for a fresh QR."
                  : "Scan. Pay. All yours."}
          </h2>
          <p className="muted">
            {transaction.status === "paid"
              ? "Payment received. Thank you for shopping with Mekong."
              : transaction.status === "failed"
                ? "This payment failed. Close checkout and create a new payment."
                : transaction.status === "expired"
                  ? "Close checkout to generate a new payment, or check a late transfer below."
                  : transaction.mode === "mock"
                    ? "A demo checkout. Use the simulator below to complete your order."
                    : "Scan with Bakong or any banking app that supports KHQR."}
          </p>
          {pending ? (
            <div className="khqr-card">
              <div className="khqr-banner">
                KHQR<span>៛</span>
              </div>
              <div className="khqr-recipient">
                <span>{transaction.merchantName}</span>
                <strong>
                  {formatMoney(transaction.amount, transaction.currency)}
                </strong>
              </div>
              <div className="qr-image">
                <Image
                  src={transaction.qrImage}
                  width={250}
                  height={250}
                  alt={`KHQR payment for ${formatMoney(transaction.amount, transaction.currency)}`}
                  unoptimized
                />
              </div>
              <div className="khqr-footer">
                {transaction.mode === "mock"
                  ? "DEMO QR · NO REAL PAYMENT"
                  : "SCAN WITH ANY KHQR BANKING APP"}
              </div>
            </div>
          ) : (
            <div className={`payment-result result-${transaction.status}`}>
              <div>
                {transaction.status === "paid" ? (
                  <CheckCheck size={40} />
                ) : transaction.status === "expired" ? (
                  <Clock3 size={40} />
                ) : (
                  <X size={40} />
                )}
              </div>
              <strong>
                {formatMoney(transaction.amount, transaction.currency)}
              </strong>
              <StatusBadge status={transaction.status} />
              {transaction.providerReference && (
                <code>{transaction.providerReference}</code>
              )}
            </div>
          )}
          {pending && (
            <div className="qr-actions">
              <Countdown expiresAt={transaction.expiresAt} />
              <a
                href={transaction.qrImage}
                download={`${transaction.orderNumber}.png`}
              >
                <Download size={14} />
                Save QR
              </a>
            </div>
          )}
          <div className="checkout-order">
            {transaction.items.map((item) => (
              <div key={item.productId}>
                <span>
                  {item.quantity} × {item.name}
                </span>
                <span>
                  {formatMoney(
                    item.quantity * item.unitPrice,
                    transaction.currency,
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="payment-details">
          <div className="section-label">
            <Radio size={16} /> PAYMENT UPDATES
          </div>
          {pending && (
            <MethodPicker
              method={method}
              onChange={(value) => {
                setMethod(value);
                setConnection("Connecting…");
              }}
              webhookAvailable={webhookAvailable}
              pollingAvailable={pollingAvailable}
            />
          )}
          <p className="detail-description">
            {method === "webhook"
              ? "The callback updates your order. A live event stream brings that status here."
              : "Your server checks the KHQR MD5 every 3 seconds until the payment is complete."}
          </p>
          {method === "webhook" && (
            <WebhookPolicy mode={transaction.webhookSignatureMode} />
          )}
          <div className={`connection-state ${pending ? "" : "complete"}`}>
            <span className={pending ? "pulse-dot" : ""} />
            {pending ? connection : `Payment ${transaction.status}`}
          </div>
          <div className="hash-detail">
            <span>TRANSACTION MD5</span>
            <code>{transaction.md5}</code>
            <CopyButton value={transaction.md5} label="Copy MD5" />
          </div>
          <details className="payload-details">
            <summary>
              View KHQR payload
              <Code2 size={14} />
            </summary>
            <code>{transaction.qr}</code>
            <CopyButton value={transaction.qr} label="Copy payload" />
          </details>
          <div className="event-section">
            <div className="section-label">ACTIVITY</div>
            <ol>
              {transaction.events.map((event) => (
                <li key={event.id}>
                  <span className="event-dot" />
                  <div>
                    <p>{event.message}</p>
                    <time>
                      {new Date(event.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}{" "}
                      · {event.source}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          {pending && transaction.mode === "mock" && (
            <div className="simulator">
              <div>
                <Terminal size={15} />
                <strong>Payment simulator</strong>
                <span>MOCK</span>
              </div>
              <p>
                {method === "webhook"
                  ? transaction.webhookSignatureMode === "signed"
                    ? "The server signs the test result before sending it to the callback handler."
                    : transaction.webhookSignatureMode === "token"
                      ? "The server adds the webhook token before sending the test result."
                      : transaction.webhookSignatureMode === "unsigned"
                        ? "Send an unsigned test result to the callback handler."
                        : "Send a test result through the legacy callback handler."
                  : "Send a test result through the mock provider."}
              </p>
              <button
                className="primary-button"
                disabled={busy || queued}
                onClick={() => simulate("paid")}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                {queued
                  ? "Result sent · waiting for update"
                  : "Simulate successful payment"}
              </button>
              <button
                className="text-button"
                disabled={busy || queued}
                onClick={() => simulate("failed")}
              >
                Simulate a failed payment
              </button>
            </div>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {(pending || transaction.status === "expired") && (
            <button
              className="secondary-button check-now"
              disabled={checking}
              onClick={checkNow}
            >
              <RefreshCw size={14} className={checking ? "spin" : ""} />
              {checking ? "Checking…" : "Check MD5 now"}
            </button>
          )}
          {!pending && (
            <button className="primary-button" onClick={onClose}>
              {transaction.status === "paid"
                ? "Back to the store"
                : "Back to checkout"}
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function ApiGuide() {
  const endpoints = [
    [
      "GET",
      "/api/v1/health-check",
      "Service health, active payment environment, and available update methods.",
    ],
    [
      "GET",
      "/api/v1/products",
      "Read the catalog with its saved USD and KHR prices.",
    ],
    [
      "PATCH",
      "/api/v1/products/:productId",
      "Save a product price with a currency and a numeric price.",
    ],
    [
      "POST",
      "/api/v1/transactions",
      "Create an order with server-calculated prices and generate its dynamic KHQR.",
    ],
    [
      "POST",
      "/api/v1/transactions/callback",
      "Receive provider batch or compact signed/token/unsigned callbacks.",
    ],
    [
      "GET",
      "/api/v1/transactions/search?md5=…&method=polling",
      "Look up a transaction and check its payment status by KHQR MD5.",
    ],
    [
      "GET",
      "/api/v1/transactions/events?md5=…",
      "Stream locally stored status changes to the checkout using server-sent events.",
    ],
    [
      "POST",
      "/api/v1/transactions/simulate",
      "Send a mock payment through webhook or polling for end-to-end testing.",
    ],
  ];
  const callback = JSON.stringify(
    {
      requestId: "0001",
      transactions: [
        {
          fromAccountId: "sender_acc@cmcb",
          toAccountId: "receiver_acc@devb",
          assetId: "khr#nbc",
          amount: 13700,
          description: "Pay back",
          createdDateMilli: 1676962944719,
          hash: "<64-character provider transaction hash>",
          qrCode: "<complete KHQR string>",
          qrType: "CORPORATE",
          senderName: "Channit Rom",
          senderAccount: "321456654",
          senderBank: "CMCBKHPPXX",
          status: "SUCCESS",
        },
      ],
    },
    null,
    2,
  );
  return (
    <section className="guide-view">
      <div className="page-heading">
        <span className="eyebrow">BUILT TO EXPERIMENT</span>
        <h1>A small store. A real integration.</h1>
        <p>
          Everything you need to test a KHQR checkout from creation to
          confirmation.
        </p>
      </div>
      <div className="guide-grid">
        <div className="panel endpoint-panel">
          <h2>Your API endpoints</h2>
          {endpoints.map(([method, path, description]) => (
            <div className="endpoint-row" key={path}>
              <span className={`http-method ${method.toLowerCase()}`}>
                {method}
              </span>
              <div>
                <code>{path}</code>
                <p>{description}</p>
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="panel guide-note">
            <div className="section-label">
              <CircleHelp size={17} /> WHICH METHOD?
            </div>
            <h3>Polling works directly with Bakong.</h3>
            <p>
              Bakong documents <code>POST /v1/check_transaction_by_md5</code>.
              The server sends the MD5 and an API key in the{" "}
              <code>x-api-key</code> header, then verifies the amount, currency,
              and recipient.
            </p>
            <h3>Batch webhooks work directly.</h3>
            <p>
              The receiver accepts the provider&apos;s <code>requestId</code>{" "}
              and <code>transactions</code> array. Each complete{" "}
              <code>qrCode</code> is hashed to find its local order; unrelated
              transfers are acknowledged safely.
            </p>
            <a
              href="https://bakong.nbc.gov.kh/download/KHQR/integration/QR%20Payment%20Integration.pdf"
              target="_blank"
              rel="noreferrer"
            >
              Bakong integration documentation
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="code-panel">
            <div>
              <span>Provider batch callback</span>
              <CopyButton value={callback} />
            </div>
            <pre>{callback}</pre>
            <p>
              POST /api/v1/transactions/callback
              <br />
              Content-Type: application/json
              <br />
              Response: status.code = 0
            </p>
          </div>
          <div className="panel guide-note signature-guide">
            <div className="section-label">
              <ShieldCheck size={16} /> WEBHOOK AUTHENTICATION
            </div>
            <h3>Choose an authentication mode at checkout.</h3>
            <p>
              Set <code>webhookSignatureMode</code> to <code>signed</code>,{" "}
              <code>token</code>, or <code>unsigned</code>. The callback
              receiver uses the mode saved with that order.
            </p>
            <h3>Signed: HMAC-SHA256</h3>
            <p>
              Set <code>WEBHOOK_SECRET</code> on the server. Send{" "}
              <code>x-webhook-timestamp</code> as Unix seconds and{" "}
              <code>x-webhook-signature</code> as <code>sha256=hex_digest</code>
              . Sign the timestamp, a period, and the exact JSON body bytes.
            </p>
            <h3>Token: shared secret header</h3>
            <p>
              Send <code>WEBHOOK_SECRET</code> in the{" "}
              <code>x-webhook-secret</code> header. The JSON body is not signed.
            </p>
            <h3>Unsigned: plain JSON</h3>
            <p>
              Send the callback body with its JSON content type and no
              authentication header. The simulator follows the mode saved with
              the checkout.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Storefront() {
  const [view, setView] = useState<View>("store");
  const [products, setProducts] = useState<Product[]>(defaultProducts);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [currency, setCurrency] = useState<Currency>("USD");
  const [method, setMethod] = useState<StatusMethod>("polling");
  const [webhookSignatureMode, setWebhookSignatureMode] =
    useState<WebhookSignatureMode>("unsigned");
  const [category, setCategory] = useState("All goods");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [healthLoading, setHealthLoading] = useState(true);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [history, setHistory] = useState<Transaction[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const checkoutMd5 = useRef<string | null>(null);

  const checkHealth = useCallback(() => {
    return requestApi<Health>("/api/v1/health-check")
      .then((result) => {
        setHealth(result);
        setHealthError(false);
        if (!result.methods.includes("polling")) setMethod("webhook");
        let selectedMode = result.defaultWebhookSignatureMode;
        try {
          const savedMode = localStorage.getItem(WEBHOOK_SIGNATURE_STORAGE_KEY);
          if (
            (savedMode === "signed" ||
              savedMode === "token" ||
              savedMode === "unsigned") &&
            result.webhookSignatureModes.includes(savedMode)
          )
            selectedMode = savedMode;
        } catch {
          /* Use the server default when browser storage is unavailable. */
        }
        setWebhookSignatureMode(selectedMode);
      })
      .catch(() => setHealthError(true))
      .finally(() => setHealthLoading(false));
  }, []);

  const loadProducts = useCallback(() => {
    return requestApi<{ data: Product[] }>("/api/v1/products")
      .then((result) => {
        setProducts(result.data);
        setCatalogError("");
        try {
          const savedCurrency = localStorage.getItem(CURRENCY_STORAGE_KEY);
          if (savedCurrency === "USD" || savedCurrency === "KHR")
            setCurrency(savedCurrency);
        } catch {
          /* The store also works when browser storage is unavailable. */
        }
      })
      .catch((error) => {
        setCatalogError(
          error instanceof Error
            ? error.message
            : "Could not load saved product prices.",
        );
      })
      .finally(() => setCatalogLoading(false));
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await requestApi<{ data: Transaction[] }>(
        "/api/v1/transactions",
      );
      setHistory(result.data);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not load transactions.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);
  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 2200);
    return () => clearTimeout(timeout);
  }, [notice]);

  const totalCount = cart.reduce((total, item) => total + item.quantity, 0);
  const total = priceOrder(cart, currency, products).amount;
  const visibleProducts = products.filter(
    (product) =>
      category === "All goods" || product.category === category.toUpperCase(),
  );

  function changeCurrency(next: Currency) {
    setCurrency(next);
    try {
      localStorage.setItem(CURRENCY_STORAGE_KEY, next);
    } catch {
      /* Keep the preference in memory when browser storage is unavailable. */
    }
  }

  function changeWebhookSignatureMode(next: WebhookSignatureMode) {
    setWebhookSignatureMode(next);
    try {
      localStorage.setItem(WEBHOOK_SIGNATURE_STORAGE_KEY, next);
    } catch {
      /* Keep the selected mode in memory when browser storage is unavailable. */
    }
  }

  function changeQuantity(productId: string, delta: number) {
    setCart((current) => {
      const exists = current.find((item) => item.productId === productId);
      if (!exists) return [...current, { productId, quantity: 1 }];
      return current
        .map((item) =>
          item.productId === productId
            ? { ...item, quantity: Math.min(20, item.quantity + delta) }
            : item,
        )
        .filter((item) => item.quantity > 0);
    });
  }

  const updateTransaction = useCallback((next: Transaction) => {
    setHistory((current) =>
      [next, ...current.filter((item) => item.md5 !== next.md5)].slice(0, 30),
    );
    if (next.status === "paid" && checkoutMd5.current === next.md5) {
      setCart([]);
      checkoutMd5.current = null;
    }
  }, []);

  async function checkout() {
    setCheckoutLoading(true);
    setError("");
    try {
      const result = await requestApi<{ data: Transaction }>(
        "/api/v1/transactions",
        post({
          items: cart,
          currency,
          method,
          webhookSignatureMode,
          expectedAmount: total,
        }),
      );
      checkoutMd5.current = result.data.md5;
      setTransaction(result.data);
      updateTransaction(result.data);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not create checkout.",
      );
      setCatalogLoading(true);
      void loadProducts();
    } finally {
      setCheckoutLoading(false);
    }
  }

  async function searchTransaction(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSearchLoading(true);
    try {
      const result = await requestApi<{ data: Transaction }>(
        `/api/v1/transactions/search?md5=${encodeURIComponent(search.trim())}&method=${method}`,
      );
      setTransaction({ ...result.data, method });
      updateTransaction(result.data);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Transaction not found.",
      );
    } finally {
      setSearchLoading(false);
    }
  }

  function navigate(next: View) {
    setView(next);
    setError("");
    if (next === "transactions") void loadHistory();
  }

  return (
    <div className="site-shell">
      <div className="announcement">
        <span>A little local. A little lovely.</span>
        <span>
          Thoughtfully picked, simply paid.
          <ArrowUpRight size={12} />
        </span>
      </div>
      <header className="site-header">
        <button
          className="brand"
          onClick={() => navigate("store")}
          aria-label="Mekong home"
        >
          <span className="brand-mark">
            <Leaf size={23} strokeWidth={1.5} />
          </span>
          <span>
            mekong<span className="brand-period">.</span>
          </span>
        </button>
        <nav aria-label="Main navigation">
          <button
            className={view === "store" ? "active" : ""}
            onClick={() => navigate("store")}
          >
            <Store size={15} />
            Storefront
          </button>
          <button
            className={view === "transactions" ? "active" : ""}
            onClick={() => navigate("transactions")}
          >
            <Radio size={15} />
            Transactions
          </button>
          <button
            className={view === "guide" ? "active" : ""}
            onClick={() => navigate("guide")}
          >
            <Code2 size={16} />
            API guide
          </button>
        </nav>
        <div className="header-actions">
          <span
            className={`environment-badge ${health?.mode === "bakong" ? "live" : ""}`}
          >
            <span />
            {healthError
              ? "Service offline"
              : !health
                ? "Connecting"
                : health.mode === "mock"
                  ? "Mock environment"
                  : "Bakong environment"}
          </span>
          <button
            className="bag-button"
            aria-label={`View bag with ${totalCount} items`}
            onClick={() => {
              navigate("store");
              setTimeout(
                () =>
                  document
                    .getElementById("order-panel")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                0,
              );
            }}
          >
            <ShoppingBag size={20} />
            <span>{totalCount}</span>
          </button>
        </div>
      </header>

      <main className="main-container">
        {view === "store" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <div className="hero-eyebrow">
                  <span />
                  EVERYDAY GOODS, A LITTLE MORE THOUGHTFUL
                </div>
                <h1>
                  Good things.
                  <br />
                  One simple <em>scan.</em>
                </h1>
                <p>
                  Small joys for your everyday. Discover our local favorites
                  <br className="desktop-break" /> and make them yours with a
                  seamless KHQR checkout.
                </p>
                <a className="hero-link" href="#collection">
                  Find your everyday favorite
                  <ArrowDown size={16} />
                </a>
                <div className="hero-trust">
                  <span className="khqr-wordmark">KHQR</span>
                  <span className="trust-divider" />
                  <span>One QR. Every banking app.</span>
                </div>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="hero-orbit orbit-one" />
                <div className="hero-orbit orbit-two" />
                <div className="hero-sun" />
                <span className="hero-spark spark-one">✳</span>
                <span className="hero-spark spark-two">✧</span>
                <div className="hero-coffee">
                  <ProductArt art="coffee" />
                </div>
                <div className="hero-cup">
                  <ProductArt art="cup" />
                </div>
                <div className="hero-sticker">
                  <Leaf size={17} />
                  <span>
                    Made for
                    <br />
                    <em>the everyday.</em>
                  </span>
                </div>
                <div className="hero-caption">
                  <span />
                  GOOD FINDS. GOOD FEELING.
                </div>
              </div>
            </section>

            <div className="shop-layout" id="collection">
              <section className="collection">
                <div className="collection-heading">
                  <div>
                    <span className="eyebrow">THE LITTLE THINGS MATTER</span>
                    <h2>Your everyday, elevated.</h2>
                  </div>
                  <span className="item-count">
                    {products.length} thoughtful finds
                  </span>
                </div>
                <div className="collection-toolbar">
                  <div className="category-tabs" aria-label="Filter products">
                    {[
                      "All goods",
                      "Home",
                      "Lifestyle",
                      "Pantry",
                      "Stationery",
                    ].map((item) => (
                      <button
                        key={item}
                        className={category === item ? "selected" : ""}
                        aria-pressed={category === item}
                        onClick={() => setCategory(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                  <label className="currency-select">
                    <span className="sr-only">Currency</span>
                    <select
                      value={currency}
                      onChange={(event) =>
                        changeCurrency(event.target.value as Currency)
                      }
                    >
                      <option value="USD">USD $</option>
                      <option value="KHR">KHR ៛</option>
                    </select>
                  </label>
                </div>
                {catalogLoading && (
                  <p className="catalog-message" role="status">
                    Loading saved prices…
                  </p>
                )}
                {catalogError && (
                  <div className="catalog-error" role="alert">
                    <p>{catalogError}</p>
                    <button
                      className="secondary-button"
                      disabled={catalogLoading}
                      onClick={() => {
                        setCatalogLoading(true);
                        void loadProducts();
                      }}
                    >
                      Retry loading prices
                    </button>
                  </div>
                )}
                <div className="product-grid">
                  {visibleProducts.map((product) => {
                    const quantity =
                      cart.find((item) => item.productId === product.id)
                        ?.quantity ?? 0;
                    return (
                      <article className="product-card" key={product.id}>
                        <div
                          className="product-visual"
                          style={{ backgroundColor: product.color }}
                        >
                          <span className="product-category">
                            {product.category}
                          </span>
                          {product.id === "mondulkiri-coffee" && (
                            <span className="favorite-label">
                              <Sparkles size={10} />
                              LOCAL FAVORITE
                            </span>
                          )}
                          <ProductArt art={product.art} />
                          {quantity > 0 && (
                            <span className="in-bag">
                              <Check size={11} />
                              {quantity} in your bag
                            </span>
                          )}
                        </div>
                        <div className="product-info">
                          <h3>{product.name}</h3>
                          <p>{product.description}</p>
                          <div className="product-bottom">
                            <strong>
                              {formatMoney(product.price[currency], currency)}
                            </strong>
                            <button
                              disabled={
                                quantity >= 20 ||
                                catalogLoading ||
                                !!catalogError
                              }
                              aria-label={`Add ${product.name} to bag`}
                              onClick={() => {
                                changeQuantity(product.id, 1);
                                setNotice(`${product.name} added to your bag`);
                              }}
                            >
                              <Plus size={15} />
                              Add to bag
                            </button>
                          </div>
                          <button
                            className="edit-price-button"
                            disabled={
                              catalogLoading ||
                              !!catalogError ||
                              checkoutLoading
                            }
                            aria-label={`Edit price for ${product.name}`}
                            onClick={() => setEditingProduct(product)}
                          >
                            <Pencil size={12} />
                            Edit price
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="collection-footnote">
                  <Leaf size={17} />
                  <span>
                    A thoughtfully made demo store, inspired by the everyday.
                  </span>
                  <span>PHNOM PENH, CAMBODIA</span>
                </div>
              </section>

              <aside className="order-sidebar">
                <section className="panel order-panel" id="order-panel">
                  <div className="panel-heading">
                    <h2>
                      Your bag<span>{totalCount}</span>
                    </h2>
                    <ShoppingBag size={19} />
                  </div>
                  {cart.length === 0 ? (
                    <div className="empty-bag">
                      <div>
                        <ShoppingBag size={27} strokeWidth={1.3} />
                        <span>+</span>
                      </div>
                      <h3>A little room for good things.</h3>
                      <p>
                        Add something you love.
                        <br />
                        Your next little joy is right here.
                      </p>
                    </div>
                  ) : (
                    <div className="cart-items">
                      {cart.map((item) => {
                        const product = products.find(
                          (product) => product.id === item.productId,
                        )!;
                        return (
                          <div className="cart-item" key={item.productId}>
                            <div
                              className="cart-thumbnail"
                              style={{ backgroundColor: product.color }}
                            >
                              <ProductArt art={product.art} />
                            </div>
                            <div className="cart-item-info">
                              <h3>{product.name}</h3>
                              <div className="quantity-control">
                                <button
                                  aria-label={`Remove one ${product.name}`}
                                  onClick={() => changeQuantity(product.id, -1)}
                                >
                                  <Minus size={11} />
                                </button>
                                <span>{item.quantity}</span>
                                <button
                                  aria-label={`Add one ${product.name}`}
                                  disabled={item.quantity >= 20}
                                  onClick={() => changeQuantity(product.id, 1)}
                                >
                                  <Plus size={11} />
                                </button>
                              </div>
                            </div>
                            <strong>
                              {formatMoney(
                                product.price[currency] * item.quantity,
                                currency,
                              )}
                            </strong>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="order-totals">
                    <div>
                      <span>Subtotal</span>
                      <span>{formatMoney(total, currency)}</span>
                    </div>
                    <div>
                      <span>Delivery</span>
                      <span className="green-text">On the house</span>
                    </div>
                    <div className="total-row">
                      <strong>Total</strong>
                      <strong>{formatMoney(total, currency)}</strong>
                    </div>
                  </div>
                  <button
                    className="primary-button checkout-button"
                    onClick={checkout}
                    disabled={
                      !cart.length ||
                      checkoutLoading ||
                      healthError ||
                      !health ||
                      catalogLoading ||
                      !!catalogError
                    }
                  >
                    {checkoutLoading ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <QrCode size={18} />
                    )}
                    {checkoutLoading
                      ? "Creating your KHQR…"
                      : "Checkout with KHQR"}
                    <ArrowRight size={16} />
                  </button>
                  <div className="checkout-reassurance">
                    <ShieldCheck size={12} />
                    {health?.mode === "bakong"
                      ? "KHQR powered by Bakong"
                      : "Demo checkout · no real money involved"}
                  </div>
                  {error && (
                    <p className="error-message" role="alert">
                      {error}
                    </p>
                  )}
                </section>
                <section className="panel integration-panel">
                  <div className="section-label">
                    <span className="tiny-icon">
                      <Code2 size={14} />
                    </span>
                    YOUR INTEGRATION<span className="small-tag">DEV</span>
                  </div>
                  <h3>How should we check payment?</h3>
                  <MethodPicker
                    method={method}
                    onChange={setMethod}
                    webhookAvailable={
                      health?.methods.includes("webhook") ?? false
                    }
                    pollingAvailable={
                      health?.methods.includes("polling") ?? false
                    }
                  />
                  <p>
                    {method === "webhook"
                      ? "Receive a callback when payment is complete. Your checkout updates in real time."
                      : "Check the transaction MD5 every 3 seconds. A direct connection to Bakong’s status API."}
                  </p>
                  {method === "webhook" && (
                    <WebhookSignaturePicker
                      mode={webhookSignatureMode}
                      onChange={changeWebhookSignatureMode}
                      secretAvailable={
                        health?.webhookSignatureModes.includes("signed") ??
                        false
                      }
                    />
                  )}
                  <div className="endpoint-preview">
                    <span>{method === "webhook" ? "POST" : "GET"}</span>
                    <code>
                      {method === "webhook"
                        ? "/transactions/callback"
                        : "/transactions/search?md5=…"}
                    </code>
                  </div>
                  <button
                    className="integration-link"
                    onClick={() => navigate("guide")}
                  >
                    Explore the API guide
                    <ArrowUpRight size={14} />
                  </button>
                </section>
                <button
                  className={`health-panel ${healthError ? "unhealthy" : ""}`}
                  onClick={() => {
                    setHealthLoading(true);
                    void checkHealth();
                  }}
                  disabled={healthLoading}
                >
                  <span className="health-indicator" />
                  <span>
                    <strong>
                      {healthError
                        ? "Service unavailable"
                        : healthLoading
                          ? "Checking service…"
                          : "All systems ready"}
                    </strong>
                    <code>/api/v1/health-check</code>
                  </span>
                  <RefreshCw
                    size={14}
                    className={healthLoading ? "spin" : ""}
                  />
                </button>
                <div className="sidebar-note">
                  <Package size={16} />
                  <p>
                    A complete checkout playground.
                    <br />
                    Create a QR, test a payment, see it happen.
                  </p>
                </div>
              </aside>
            </div>
          </>
        )}

        {view === "transactions" && (
          <section className="transactions-view">
            <div className="page-heading">
              <span className="eyebrow">EVERY SCAN HAS A STORY</span>
              <h1>Follow the good things.</h1>
              <p>
                Your latest orders, payment statuses, and a little visibility
                into every checkout.
              </p>
            </div>
            <div className="transaction-tools">
              <form className="md5-search" onSubmit={searchTransaction}>
                <Search size={18} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search a transaction by its MD5…"
                  aria-label="Transaction MD5"
                  required
                  pattern="[a-fA-F0-9]{32}"
                  title="Enter a 32-character hexadecimal MD5"
                />
                <button className="primary-button" disabled={searchLoading}>
                  {searchLoading ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                  Search
                </button>
              </form>
              <button
                className="secondary-button"
                onClick={loadHistory}
                disabled={historyLoading}
              >
                <RefreshCw size={15} className={historyLoading ? "spin" : ""} />
                Refresh
              </button>
            </div>
            <div className="search-method">
              <span>Lookup method</span>
              <MethodPicker
                method={method}
                onChange={setMethod}
                webhookAvailable={health?.methods.includes("webhook") ?? false}
                pollingAvailable={health?.methods.includes("polling") ?? false}
              />
              <span>
                {method === "webhook"
                  ? "Read the latest callback status"
                  : "Query the payment provider by MD5"}
              </span>
            </div>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <div className="panel transactions-panel">
              {historyLoading && !history.length ? (
                <div className="empty-state">
                  <LoaderCircle className="spin" size={28} />
                  <p>Loading your transactions…</p>
                </div>
              ) : !history.length ? (
                <div className="empty-state">
                  <div>
                    <Radio size={32} strokeWidth={1.3} />
                  </div>
                  <h2>Your first scan starts here.</h2>
                  <p>
                    Create a checkout and watch its payment journey come to
                    life.
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => navigate("store")}
                  >
                    Explore the store
                    <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Order / MD5</th>
                        <th>Created</th>
                        <th>Amount</th>
                        <th>Method</th>
                        <th>Status</th>
                        <th>
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((item) => (
                        <tr key={item.md5}>
                          <td>
                            <strong>{item.orderNumber}</strong>
                            <code>{item.md5}</code>
                          </td>
                          <td>
                            {new Date(item.createdAt).toLocaleString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="amount-cell">
                            {formatMoney(item.amount, item.currency)}
                          </td>
                          <td>
                            <span className="table-method">
                              {item.method === "webhook" ? (
                                <Webhook size={14} />
                              ) : (
                                <RefreshCw size={13} />
                              )}
                              {item.method}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={item.status} />
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`View order ${item.orderNumber}`}
                              onClick={() => setTransaction(item)}
                            >
                              <ChevronRight size={19} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p className="history-note">
              The 30 most recent orders in this environment. Transactions are
              stored locally in SQLite.
            </p>
          </section>
        )}
        {view === "guide" && <ApiGuide />}
      </main>
      <footer className="site-footer">
        <div>
          <Leaf size={17} />
          <strong>mekong.</strong>
          <span>Small joys. Simple payments.</span>
        </div>
        <span>
          Made for the everyday.<span className="footer-dot">·</span>Powered by
          KHQR
        </span>
        <a href="https://bakong.nbc.gov.kh/" target="_blank" rel="noreferrer">
          Meet Bakong
          <ArrowUpRight size={13} />
        </a>
      </footer>
      <div className={`toast ${notice ? "visible" : ""}`} role="status">
        <Check size={17} />
        {notice}
      </div>
      {editingProduct && (
        <PriceEditor
          key={editingProduct.id}
          product={editingProduct}
          initialCurrency={currency}
          onClose={() => setEditingProduct(null)}
          onSaved={(product, selectedCurrency) => {
            setProducts((current) =>
              current.map((item) => (item.id === product.id ? product : item)),
            );
            changeCurrency(selectedCurrency);
            setEditingProduct(null);
            setError("");
            setNotice(
              `${product.name} updated to ${formatMoney(product.price[selectedCurrency], selectedCurrency)}`,
            );
          }}
        />
      )}
      {transaction && (
        <CheckoutDialog
          key={transaction.md5}
          initial={transaction}
          onClose={() => {
            setTransaction(null);
            if (view === "transactions") void loadHistory();
          }}
          onUpdate={updateTransaction}
          webhookAvailable={health?.methods.includes("webhook") ?? false}
          pollingAvailable={health?.methods.includes("polling") ?? false}
        />
      )}
    </div>
  );
}
