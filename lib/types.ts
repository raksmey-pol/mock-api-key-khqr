export type Currency = "USD" | "KHR";
export type StatusMethod = "webhook" | "polling";
export type WebhookSignatureMode = "signed" | "token" | "unsigned";
export type PaymentMode = "mock" | "bakong";
export type PaymentStatus = "pending" | "paid" | "failed" | "expired";

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
};
