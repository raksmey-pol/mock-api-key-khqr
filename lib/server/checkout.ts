import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CheckoutPageMode,
  CheckoutPagePaymentPayload,
  CheckoutSession,
  CheckoutSessionStatus,
  Currency,
  Transaction,
} from "../types";
import { addEvent, applyCancellation, applyLateSettlement, applyRemoteResult } from "./checkout-settle";
import { getConfig, merchantToken } from "./config";
import { ApiError } from "./http";
import { buildKhqrDetails, generateKhqr } from "./khqr";
import {
  activeBillSession,
  insertCheckoutSession,
  listCheckoutSessions,
  readCheckoutIdempotency,
  readCheckoutSession,
  readCheckoutSessionByMd5,
  readCheckoutSessionByToken,
  readTransaction,
  recordCheckoutIdempotency,
  updateCheckoutSession,
  updateTransaction,
} from "./store";

export { readCheckoutSessionByToken };

// ---------------------------------------------------------------------------
// Envelopes and merchant authentication (integration guide section 4)
// ---------------------------------------------------------------------------

type StatusEnvelope = { status: { code: string; message: string } };

export function openApiJson(body: unknown, status = 200) {
  return Response.json(
    { status: { code: "00", message: "Success" }, data: body },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function openApiError(error: unknown) {
  let code = "500";
  let message = "The checkout request could not be completed.";
  let httpStatus = 500;
  if (error instanceof ApiError) {
    code = String(error.status);
    message = error.message;
    httpStatus = error.status;
  } else if (error instanceof z.ZodError) {
    code = "400";
    message = error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    httpStatus = 400;
  } else {
    console.error("KHQR checkout request failed:", error);
  }
  const body: StatusEnvelope = { status: { code, message } };
  return Response.json(body, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}

// Merchant tokens stay server to server; the browser pays checkout_url with its
// signed capability token instead (integration guide section 2.3).
export function requireMerchantAuth(request: Request) {
  const config = getConfig();
  const expected = merchantToken(config);
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    throw new ApiError(401, "Missing or invalid merchant token.");
  }
}

// ---------------------------------------------------------------------------
// Requests and validation (integration guide section 5)
// ---------------------------------------------------------------------------

export const checkoutCreateSchema = z.object({
  amount: z.number().positive().finite(),
  currency: z.enum(["USD", "KHR"]),
  billNo: z.string().min(1).max(32),
  successUrl: z.string().max(2048).optional(),
  success_url: z.string().max(2048).optional(),
  expirySeconds: z.coerce.number().int().min(60).max(600).optional(),
  description: z.string().min(1).max(128).optional(),
}).strict();

export type CheckoutCreateInput = z.infer<typeof checkoutCreateSchema>;

const uuidSchema = z.string().uuid();
const billNoPattern = /^[a-zA-Z0-9._-]{1,32}$/;

function validateAmount(amount: number, currency: Currency) {
  if (amount <= 0) return "Amount must be greater than zero.";
  if (currency === "KHR" && !Number.isInteger(amount)) return "KHR amounts must be whole riel.";
  if (currency === "USD" && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-9) {
    return "USD amounts support at most two decimal places.";
  }
  return null;
}

function validateSuccessUrl(successUrl: string, requireHttps: boolean) {
  let url: URL;
  try { url = new URL(successUrl); } catch { return "successUrl must be a valid URL."; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (requireHttps && url.protocol !== "https:") return "successUrl must use HTTPS.";
  if (!requireHttps && url.protocol !== "https:" && !local) return "successUrl must use HTTPS.";
  return null;
}

const billNoSchema = z.string().min(1).regex(billNoPattern, "billNo must use 1 to 32 letters, numbers, dots, dashes, or underscores.");

function normalizeMintInput(input: CheckoutCreateInput, requireHttps: boolean) {
  if (input.successUrl && input.success_url && input.successUrl !== input.success_url) {
    throw new ApiError(400, "successUrl and success_url must be identical when both are supplied.");
  }
  const successUrl = input.successUrl ?? input.success_url;
  if (successUrl) {
    const urlError = validateSuccessUrl(successUrl, requireHttps);
    if (urlError) throw new ApiError(400, urlError);
  }
  const amountError = validateAmount(input.amount, input.currency);
  if (amountError) throw new ApiError(400, amountError);
  if (!billNoSchema.safeParse(input.billNo).success) throw new ApiError(400, "billNo must be 1 to 32 letters, numbers, dots, dashes, or underscores.");
  return {
    amount: input.amount,
    currency: input.currency,
    billNo: input.billNo,
    successUrl: successUrl ?? null,
    expirySeconds: input.expirySeconds ?? 300,
    description: input.description ?? null,
  };
}

// Canonical mint payload for idempotency comparisons.
function canonicalPayload(normalized: ReturnType<typeof normalizeMintInput>) {
  return JSON.stringify(normalized);
}

function isUuid(value: string) {
  return uuidSchema.safeParse(value).success;
}

function isUniqueConflict(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function successOrigin(successUrl: string | null, fallback: string) {
  if (successUrl && /^https?:\/\//.test(successUrl)) return new URL(successUrl).origin;
  return fallback.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Session views
// ---------------------------------------------------------------------------

// Merchant-visible session data (integration guide section 13): everything
// except the browser capability token and the checkout_url.
export function merchantSessionView(session: CheckoutSession) {
  return {
    session_id: session.sessionId,
    status: session.status,
    md5: session.md5,
    billNo: session.billNo,
    amount: session.amount,
    currency: session.currency,
    description: session.description,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    payment_at: session.paymentAt,
    expiry: session.expiry,
  };
}

// ---------------------------------------------------------------------------
// Status machine (integration guide sections 3.1 and 7.3)
// ---------------------------------------------------------------------------

const TERMINAL_DIVERGENCE_NOTE = "A settlement arrived after this session reached a terminal status.";

function isTerminal(status: CheckoutSessionStatus) {
  return status === "SUCCESS" || status === "FAILED" || status === "TIMEOUT" || status === "EXPIRED" || status === "CANCELLED";
}

function sessionExpiryReached(session: CheckoutSession) {
  return session.expiry <= nowSeconds();
}

// Derive the next session status. Terminal states never change again; a late
// settlement after expiry is recorded as divergence evidence instead.
function deriveSessionStatus(session: CheckoutSession, transaction: Transaction | null): {
  status: CheckoutSessionStatus | null;
  paymentAt: number | null;
} {
  if (isTerminal(session.status)) return { status: null, paymentAt: session.paymentAt };
  if (transaction?.status === "paid") {
    if (transaction.amount !== session.amount || transaction.currency !== session.currency) {
      return { status: null, paymentAt: null };
    }
    return { status: "SUCCESS", paymentAt: transaction.paidAt ? Math.floor(Date.parse(transaction.paidAt) / 1000) : nowSeconds() };
  }
  if (transaction?.status === "failed") return { status: "FAILED", paymentAt: null };
  const expired = transaction
    ? transaction.status === "expired" || (transaction.status === "pending" && Date.parse(transaction.expiresAt) <= Date.now())
    : sessionExpiryReached(session);
  if (expired) return { status: "EXPIRED", paymentAt: null };
  return { status: null, paymentAt: null };
}

// Sync the persisted session with the linked local order, then return it.
export function syncCheckoutSession(session: CheckoutSession): CheckoutSession {
  const transaction = session.md5 ? readTransaction(session.md5) : null;
  const derivedStatus = deriveSessionStatus(session, transaction).status;
  if (!derivedStatus) return session;
  const derivedPaymentAt = deriveSessionStatus(session, transaction).paymentAt;
  const next = updateCheckoutSession(session.sessionId, (current) => {
    if (isTerminal(current.status)) {
      if (current.status === "EXPIRED" && derivedStatus === "SUCCESS") {
        if (transaction && !transaction.events.some((event) => event.message.startsWith("Late payment after"))) {
          updateTransaction(current.md5, applyLateSettlement);
        }
        if (!current.notes.includes(TERMINAL_DIVERGENCE_NOTE)) {
          return { ...current, notes: [...current.notes, TERMINAL_DIVERGENCE_NOTE], updatedAt: nowSeconds() };
        }
      }
      return null;
    }
    return { ...current, status: derivedStatus, paymentAt: derivedPaymentAt, updatedAt: nowSeconds(), terminal: true };
  });
  return next ?? session;
}

function currentSession(sessionId: string) {
  const session = readCheckoutSession(sessionId);
  if (!session) throw new ApiError(404, "No checkout session found for this session id.");
  return syncCheckoutSession(session);
}

// ---------------------------------------------------------------------------
// Minting (integration guide section 5)
// ---------------------------------------------------------------------------

// Standalone mint through the emulated merchant API. The endpoint generates the
// KHQR itself, exactly as the hosted checkout Open API would.
export function mintStandaloneCheckoutSession(parameters: {
  input: CheckoutCreateInput;
  idempotencyKey: string;
  origin: string;
}): { replay: boolean; payload: Record<string, unknown> } {
  const config = getConfig();
  if (!isUuid(parameters.idempotencyKey)) {
    throw new ApiError(400, "Idempotency-Key header must be a UUID.");
  }
  const normalized = normalizeMintInput(parameters.input, false);
  const canonical = canonicalPayload(normalized);
  const cached = readCheckoutIdempotency(parameters.idempotencyKey);
  if (cached) {
    if (cached.payload !== canonical) throw new ApiError(422, "Idempotency key is already used with a different request payload.");
    return { replay: true, payload: cached.response as Record<string, unknown> };
  }

  const existing = activeBillSession(normalized.billNo);
  let minted: CheckoutSession;
  if (existing) {
    // Bill identity: a non-terminal session for the bill is returned as-is.
    minted = existing;
  } else {
    const expiration = nowSeconds() + normalized.expirySeconds;
    const details = buildKhqrDetails({
      accountId: config.accountId,
      merchantName: config.merchantName,
      merchantCity: config.merchantCity,
      acquiringBank: config.acquiringBank || undefined,
      merchantId: config.merchantId || undefined,
      currency: normalized.currency,
      amount: normalized.amount,
      billNumber: normalized.billNo,
      expirationTimestamp: expiration * 1000,
    });
    const response = generateKhqr(details);
    const data = z.object({ qr: z.string() }).safeParse(response.data);
    if (response.status.code !== 0 || !data.success) {
      throw new ApiError(503, response.status.message ?? "KHQR generation failed. Check merchant settings.");
    }
    const md5 = createHash("md5").update(data.data.qr).digest("hex");
    minted = {
      sessionId: randomUUID(),
      token: randomBytes(30).toString("base64url"),
      status: "CREATED",
      amount: normalized.amount,
      currency: normalized.currency,
      billNo: normalized.billNo,
      description: normalized.description,
      successUrl: normalized.successUrl,
      merchantName: config.merchantName,
      accountId: config.accountId,
      khqr: data.data.qr,
      khqrImage: null,
      md5,
      createdAt: nowSeconds(),
      updatedAt: nowSeconds(),
      paymentAt: null,
      expiry: expiration,
      terminal: false,
      notes: [],
    };
    if (readCheckoutSessionByMd5(minted.md5)) throw new ApiError(409, "A checkout session already exists for this KHQR value.");
    try {
      insertCheckoutSession(minted);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const active = activeBillSession(normalized.billNo);
      if (!active) throw new ApiError(409, "Conflicting active mint. Read the bill's existing session and reconcile.");
      minted = active;
    }
  }

  const payload = {
    checkout_url: `${successOrigin(minted.successUrl, parameters.origin)}/checkout/${minted.token}`,
    session_id: minted.sessionId,
    md5: minted.md5,
    expiry: minted.expiry,
    amount: minted.amount,
    currency: minted.currency,
    billNo: minted.billNo,
    status: minted.status,
  };
  if (!cached) recordCheckoutIdempotency(parameters.idempotencyKey, canonical, 200, payload);
  return { replay: false, payload };
}

// Server-side mint for a storefront order. The order already persisted its
// dynamic KHQR, so the session links to it instead of generating a new QR, and
// settlement of the transaction drives the session forward.
export function mintCheckoutSessionForTransaction(parameters: {
  transaction: Transaction;
  origin: string;
  expirySeconds: number;
  successUrl?: string;
}): { session: CheckoutSession; checkoutUrl: string } {
  const { transaction, origin } = parameters;
  const normalized = normalizeMintInput({
    amount: transaction.amount,
    currency: transaction.currency,
    billNo: transaction.orderNumber,
    successUrl: parameters.successUrl ?? `${origin.replace(/\/$/, "")}/checkout/return?bill={BILL_NO}`,
    expirySeconds: parameters.expirySeconds,
  }, false);
  const session = {
    sessionId: randomUUID(),
    token: randomBytes(30).toString("base64url"),
    status: "CREATED",
    amount: normalized.amount,
    currency: normalized.currency,
    billNo: normalized.billNo,
    description: normalized.description,
    successUrl: normalized.successUrl,
    merchantName: transaction.merchantName,
    accountId: transaction.accountId,
    khqr: transaction.qr,
    khqrImage: transaction.qrImage,
    md5: transaction.md5,
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
    paymentAt: null,
    expiry: nowSeconds() + normalized.expirySeconds,
    terminal: false,
    notes: [],
  } satisfies CheckoutSession;
  try {
    insertCheckoutSession(session);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const active = activeBillSession(normalized.billNo) ?? readCheckoutSessionByMd5(transaction.md5);
    if (!active) throw new ApiError(409, "Conflicting active mint. Read the order's existing session and reconcile.");
    return { session: active, checkoutUrl: checkoutUrlForSession(active, origin) };
  }
  return { session, checkoutUrl: checkoutUrlForSession(session, origin) };
}

export function checkoutUrlForSession(session: CheckoutSession, origin: string) {
  return `${successOrigin(session.successUrl, origin).replace(/\/$/, "")}/checkout/${session.token}`;
}

// ---------------------------------------------------------------------------
// Storefront attachment (integration guide sections 5 and 6)
// ---------------------------------------------------------------------------

const SUCCESS_URL_TEMPLATE = "/checkout/return?bill={BILL_NO}";

// Persist session_id, checkout_url, and the presentation mode on the order
// before the checkout view renders (integration guide 5.2), then hand the
// capability URL back to the storefront.
export async function attachCheckoutSession(transaction: Transaction, options: {
  origin: string;
  pageMode: CheckoutPageMode;
}): Promise<Transaction> {
  const config = getConfig();
  const expirySeconds = config.expirationMinutes * 60;
  const successUrl = `${options.origin.replace(/\/$/, "")}${SUCCESS_URL_TEMPLATE}`;
  if (config.checkoutProvider === "bakong") {
    const remote = await mintRemoteCheckoutSession({
      amount: transaction.amount,
      currency: transaction.currency,
      billNo: transaction.orderNumber,
      successUrl,
      expirySeconds,
      description: `Mekong Store order ${transaction.orderNumber}`,
    });
    return updateTransaction(transaction.md5, (current) => attachFields(current, options.pageMode, remote.session_id, remote.checkout_url, "bakong"))!;
  }
  const { session, checkoutUrl } = mintCheckoutSessionForTransaction({
    transaction, origin: options.origin, expirySeconds, successUrl,
  });
  return updateTransaction(transaction.md5, (current) => attachFields(current, options.pageMode, session.sessionId, checkoutUrl, "mock"))!;
}

function attachFields(
  current: Transaction,
  pageMode: CheckoutPageMode,
  sessionId: string,
  checkoutUrl: string,
  provider: "mock" | "bakong",
) {
  if (current.status !== "pending") return current;
  return addEvent({
    ...current,
    checkoutPageMode: pageMode,
    checkoutSessionId: sessionId,
    checkoutUrl,
  }, "checkout", `Hosted checkout page session minted (${provider}).`);
}

// ---------------------------------------------------------------------------
// Read, long-poll, cancel, list (integration guide sections 5, 6 and 7)
// ---------------------------------------------------------------------------

export function readMerchantSession(sessionId: string) {
  return merchantSessionView(currentSession(sessionId));
}

export async function waitForMerchantSession(sessionId: string, window: number) {
  const startedAt = Date.now();
  for (;;) {
    const session = currentSession(sessionId);
    if (isTerminal(session.status) || Date.now() - startedAt >= window * 1000) {
      return merchantSessionView(session);
    }
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.floor(Math.random() * 200)));
  }
}

export function cancelCheckoutSession(sessionId: string) {
  const session = currentSession(sessionId);
  if (isTerminal(session.status)) throw new ApiError(409, `Session is already ${session.status}`);
  const cancelled = updateCheckoutSession(session.sessionId, (current) => {
    if (isTerminal(current.status)) return null;
    return {
      ...current,
      status: "CANCELLED",
      terminal: true,
      updatedAt: nowSeconds(),
      notes: [...current.notes, "Cancelled by the merchant while the session was pending."],
    };
  });
  if (!cancelled) throw new ApiError(409, "Session is already terminal.");
  if (cancelled.md5) updateTransaction(cancelled.md5, applyCancellation);
  return cancelled;
}

// Cursor pages: opaque base64url of the last created-at and session id.
function decodeCursor(cursor?: string) {
  if (!cursor) return undefined;
  const [createdAt, sessionId] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!/^\d+$/.test(createdAt ?? "") || !sessionId || !isUuid(sessionId)) {
    throw new ApiError(400, "cursor must be the opaque value returned by a previous page.");
  }
  return { createdAt: Number(createdAt), sessionId };
}

export function listMerchantSessions(options: {
  statuses?: string[];
  since?: number;
  until?: number;
  updatedSince?: number;
  billNo?: string;
  limit: number;
  cursor?: string;
}) {
  // The generic gateway status expands to the concrete non-terminal ones.
  const statuses = options.statuses?.flatMap((status) => (status === "PENDING" ? ["CREATED", "SCANNED"] : [status]));
  const sessions = listCheckoutSessions({ ...options, statuses, cursor: decodeCursor(options.cursor) });
  const last = sessions.at(-1);
  const hasMore = sessions.length === options.limit;
  return {
    sessions: sessions.map(merchantSessionView),
    cursor: hasMore && last ? Buffer.from(`${last.createdAt}|${last.sessionId}`, "utf8").toString("base64url") : null,
  };
}

// ---------------------------------------------------------------------------
// Browser payment payload (integration guide section 8: endpoint #5)
// ---------------------------------------------------------------------------

export async function paymentPayload(token: string): Promise<CheckoutPagePaymentPayload> {
  const config = getConfig();
  const session = readCheckoutSessionByToken(token);
  if (!session) throw new ApiError(404, "This checkout link is not valid.");
  const synced = syncCheckoutSession(session);
  // The hosted page is presentation only for real sessions, but this mock
  // emulation owns the whole loop: like the real page polling its provider
  // internally, endpoint #5 advances a locally settled mock payment so the
  // full-page redirect flow completes without the storefront's listener.
  if (config.checkoutProvider === "mock" && synced.md5 && !isTerminal(synced.status)) {
    try {
      const { pollTransaction } = await import("./transactions");
      await pollTransaction(synced.md5);
    } catch {
      /* The payload simply stays pending; the next poll re-checks. */
    }
  }
  const settled = syncCheckoutSession(readCheckoutSessionByToken(token) ?? synced);
  return {
    status: settled.status,
    amount: settled.amount,
    currency: settled.currency,
    merchant_name: settled.merchantName || config.merchantName,
    bill_display: settled.billNo,
    expiry: settled.expiry,
    created_at: settled.createdAt,
    khqr: settled.khqr,
    khqr_image: settled.khqrImage ?? null,
    merchant_origin: successOrigin(settled.successUrl, "http://localhost"),
    success_url: settled.successUrl,
    deeplink: null,
  };
}

// One request per 2 seconds per checkout token (integration guide section 8).
function rateLimitState() {
  const holder = globalThis as typeof globalThis & { khqrCheckoutRate?: Map<string, number> };
  holder.khqrCheckoutRate ??= new Map();
  return holder.khqrCheckoutRate;
}

export function enforcePaymentRateLimit(token: string) {
  const state = rateLimitState();
  const last = state.get(token);
  if (last !== undefined && Date.now() - last < 2000) {
    throw new ApiError(429, "This payment endpoint accepts one request every 2 seconds.");
  }
  state.set(token, Date.now());
}

// ---------------------------------------------------------------------------
// Mock settlement through the hosted page demo controls
// ---------------------------------------------------------------------------

export function sessionForSimulation(token: string) {
  const session = readCheckoutSessionByToken(token);
  if (!session) throw new ApiError(404, "This checkout link is not valid.");
  const synced = syncCheckoutSession(session);
  if (isTerminal(synced.status)) throw new ApiError(409, `This checkout session is already ${synced.status}.`);
  const transaction = synced.md5 ? readTransaction(synced.md5) : null;
  if (!transaction) throw new ApiError(404, "This checkout session is not linked to a storefront order. Simulate from the storefront instead.");
  return { session: synced, transaction };
}

// ---------------------------------------------------------------------------
// Real Bakong Open API client (integration guide sections 5 and 13)
// ---------------------------------------------------------------------------

export type RemoteCheckoutSession = {
  checkout_url: string;
  session_id: string;
  md5: string;
  status: CheckoutSessionStatus | "PENDING";
  billNo: string;
  amount: number;
  currency: Currency;
  expiry: number;
  payment_at?: number;
};

const remoteMintData = z.object({
  checkout_url: z.string(),
  session_id: z.string().min(1),
  md5: z.string().min(1),
  expiry: z.number().int(),
  amount: z.number().positive(),
  currency: z.enum(["USD", "KHR"]),
  billNo: z.string().min(1),
  status: z.string(),
}).passthrough();

function checkoutApiConfig() {
  const config = getConfig();
  if (config.checkoutProvider !== "bakong" || !config.bakongMerchantToken || !config.bakongCheckoutApiUrl) {
    throw new ApiError(503, "BAKONG_MERCHANT_TOKEN and BAKONG_CHECKOUT_API_URL are required for the real checkout page.");
  }
  return { base: config.bakongCheckoutApiUrl.replace(/\/$/, ""), token: config.bakongMerchantToken };
}

export function isRealCheckoutProvider() {
  return getConfig().checkoutProvider === "bakong";
}

export async function mintRemoteCheckoutSession(input: {
  amount: number;
  currency: Currency;
  billNo: string;
  successUrl: string;
  expirySeconds: number;
  description?: string;
}): Promise<RemoteCheckoutSession> {
  const { base, token } = checkoutApiConfig();
  let response: Response;
  try {
    response = await fetch(`${base}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(502, "The Bakong checkout Open API is unreachable or timed out.");
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError(502, "The Bakong checkout Open API returned a non-JSON response."); }
  if (!response.ok) {
    const message = (body as StatusEnvelope)?.status?.message ?? `HTTP ${response.status}`;
    throw new ApiError(502, `The Bakong checkout Open API rejected the session: ${message}`);
  }
  const data = remoteMintData.safeParse((body as { data?: unknown }).data);
  if (!data.success) throw new ApiError(502, "The Bakong checkout Open API returned an invalid session payload.");
  return data.data as RemoteCheckoutSession;
}

const remoteReadData = z.object({
  session_id: z.string().min(1),
  status: z.string().min(1),
  md5: z.string().min(1),
  billNo: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["USD", "KHR"]),
  payment_at: z.number().optional(),
}).passthrough();

export type RemoteReadResult = z.infer<typeof remoteReadData>;

export async function readRemoteCheckoutSession(sessionId: string, window = 90): Promise<RemoteReadResult> {
  const { base, token } = checkoutApiConfig();
  let response: Response;
  try {
    response = await fetch(`${base}/v1/checkout/sessions/${encodeURIComponent(sessionId)}?wait=true&w=${window}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(window * 1000 + 15_000),
    });
  } catch {
    throw new ApiError(502, "The Bakong checkout Open API is unreachable or timed out.");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ApiError(503, "The Bakong checkout Open API rejected the merchant token.");
    if (response.status === 404) throw new ApiError(404, "The Bakong checkout session could not be found.");
    throw new ApiError(502, `The Bakong checkout Open API returned HTTP ${response.status}.`);
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError(502, "The Bakong checkout Open API returned a non-JSON response."); }
  const data = remoteReadData.safeParse((body as { data?: unknown }).data);
  if (!data.success) throw new ApiError(502, "The Bakong checkout Open API returned an invalid session payload.");
  return data.data;
}

export const REMOTE_TERMINAL = new Set(["SUCCESS", "FAILED", "TIMEOUT", "EXPIRED", "CANCELLED"]);

// Durable waiter for real sessions. The page is presentation only, so the
// merchant backend keeps re-arming long polls until a terminal status (section
// 7.1) and then performs the verified, idempotent settlement write (7.2).
export async function runCheckoutPageWaiter(parameters: { sessionId: string; md5: string }) {
  for (let attempt = 0; attempt < 720; attempt++) {
    const session = await readRemoteCheckoutSession(parameters.sessionId);
    if (!REMOTE_TERMINAL.has(session.status)) {
      // Re-arm with jitter; never poll in a tight loop (integration guide 7.1).
      await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 500)));
      continue;
    }
    updateTransaction(parameters.md5, (transaction) => applyRemoteResult(transaction, {
      status: session.status,
      amount: session.amount,
      currency: session.currency,
      billNo: session.billNo,
      sessionId: session.session_id,
      paymentAt: session.payment_at,
    }));
    return;
  }
}
