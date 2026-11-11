import { BakongKHQR } from "bakong-khqr";
import QRCode from "qrcode";
import type { Currency } from "../types";

export type KhqrDetails = {
  bakongAccountID: string;
  merchantName: string;
  merchantCity: string;
  acquiringBank?: string;
  merchantID?: string;
  currency: number; // 840 = USD, 116 = KHR
  amount: number;
  billNumber: string;
  storeLabel?: string;
  terminalLabel?: string;
  expirationTimestamp: number;
};

function khqrCurrency(currency: Currency) {
  return currency === "USD" ? 840 : 116;
}

export function buildKhqrDetails(input: {
  accountId: string;
  merchantName: string;
  merchantCity: string;
  acquiringBank?: string;
  merchantId?: string;
  currency: Currency;
  amount: number;
  billNumber: string;
  expirationTimestamp: number;
}): KhqrDetails {
  return {
    bakongAccountID: input.accountId,
    merchantName: input.merchantName,
    merchantCity: input.merchantCity,
    ...(input.acquiringBank ? { acquiringBank: input.acquiringBank } : {}),
    ...(input.merchantId ? { merchantID: input.merchantId } : {}),
    currency: khqrCurrency(input.currency),
    amount: input.amount,
    billNumber: input.billNumber,
    storeLabel: "Mekong Store",
    terminalLabel: "Web checkout",
    expirationTimestamp: input.expirationTimestamp,
  };
}

// One generation point for every dynamic KHQR in this store, whether it backs an
// inline checkout or a hosted checkout page session.
export function generateKhqr(details: KhqrDetails) {
  const sdk = new BakongKHQR();
  return details.merchantID
    ? sdk.generateMerchant({ ...details, merchantID: details.merchantID, acquiringBank: details.acquiringBank ?? "" })
    : sdk.generateIndividual(details);
}

export async function qrImage(qr: string) {
  return QRCode.toDataURL(qr, { width: 400, margin: 4, errorCorrectionLevel: "M" });
}
