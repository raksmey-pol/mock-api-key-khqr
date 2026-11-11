export type Currency = "USD" | "KHR";
export type StatusMethod = "webhook" | "polling";
export type WebhookSignatureMode = "signed" | "token" | "unsigned";
export type PaymentMode = "mock" | "bakong";
export type PaymentStatus = "pending" | "paid" | "failed" | "expired";

// Presentation of the checkout: the inline QR card or the hosted Bakong
// checkout page (embedded in an iframe or as a full-page redirect).
export type CheckoutPageMode = "iframe" | "redirect";
export type CheckoutProvider = "mock" | "bakong";
// Session statuses follow the hosted checkout page's forward-only state machine.
export type CheckoutSessionStatus =
  | "CREATED"
  | "SCANNED"
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "EXPIRED"
  | "CANCELLED";

// The sanitized browser payload served to the hosted checkout page. It never
// includes the md5 or session id.
export type CheckoutPagePaymentPayload = {
  status: CheckoutSessionStatus;
  amount: number;
  currency: Currency;
  merchant_name: string;
  bill_display: string;
  expiry: number;
  created_at: number;
  khqr: string;
  khqr_image: string | null;
  merchant_origin: string;
  success_url: string | null;
  deeplink: string | null;
};

export type Product = {
  id: string;
  name: string;
  description: string;
  category: string;
  price: Record<Currency, number>;
  color: string;
  art: "coffee" | "cup" | "tote" | "notebook" | "candle" | "bottle";
};

export type CartItem = { productId: string; quantity: number };

export type OrderItem = CartItem & {
  name: string;
  unitPrice: number;
};

export type TransactionEvent = {
  id: string;
  at: string;
  source: "checkout" | "webhook" | "polling" | "system";
  message: string;
};

export type Transaction = {
  id: string;
  orderNumber: string;
  md5: string;
  qr: string;
  qrImage: string;
  amount: number;
  currency: Currency;
  items: OrderItem[];
  status: PaymentStatus;
  method: StatusMethod;
  // Orders created before authentication modes were added use legacy shared-secret authentication.
  webhookSignatureMode?: WebhookSignatureMode;
  mode: PaymentMode;
  merchantName: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  checkedAt: string | null;
  paidAt: string | null;
  providerReference: string | null;
  events: TransactionEvent[];
  // Present only when the checkout was created through the hosted checkout page.
  // checkoutUrl is a capability URL: keep it out of analytics and logs.
  checkoutPageMode?: CheckoutPageMode;
  checkoutSessionId?: string;
  checkoutUrl?: string;
};

export type CheckoutSession = {
  sessionId: string;
  token: string;
  status: CheckoutSessionStatus;
  amount: number;
  currency: Currency;
  billNo: string;
  description: string | null;
  // Template with the optional {BILL_NO} placeholder the hosted page substitutes.
  successUrl: string | null;
  merchantName: string;
  accountId: string;
  khqr: string;
  khqrImage: string | null;
  // When the checkout page orders from this store, the local order links by md5;
  // its status drives the session forward.
  md5: string;
  createdAt: number;
  updatedAt: number;
  paymentAt: number | null;
  // Unix seconds.
  expiry: number;
  terminal: boolean;
  // Operational notes such as a late settlement arriving after expiry.
  notes: string[];
};

export type Receipt = {
  status: "paid";
  amount: number;
  currency: Currency;
  toAccountId: string;
  transactionId: string;
};

export type ProviderResult = Receipt | { status: "pending" | "failed" };

export type Health = {
  status: "ok" | "error";
  mode: PaymentMode;
  storage: string;
  timestamp: string;
  merchantName: string;
  methods: StatusMethod[];
  webhookSignatureModes: WebhookSignatureMode[];
  defaultWebhookSignatureMode: WebhookSignatureMode;
  pollIntervalMs: number;
  checkoutPage: {
    available: boolean;
    provider: CheckoutProvider;
    configError?: string;
  };
};
