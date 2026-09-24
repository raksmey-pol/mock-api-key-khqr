// The published @types package predates dynamic expiration and incorrectly
// requires acquiringBank for individual QR codes. These declarations describe
// the 1.0.20 SDK surface used by this app; responses are validated at runtime.
declare module "bakong-khqr" {
  export interface IndividualInfo {
    bakongAccountID: string;
    merchantName: string;
    merchantCity: string;
    acquiringBank?: string;
    currency: number;
    amount: number;
    billNumber?: string;
    storeLabel?: string;
    terminalLabel?: string;
    expirationTimestamp: number;
  }

  export interface MerchantInfo extends IndividualInfo {
    merchantID: string;
    acquiringBank: string;
  }

  export interface KHQRResponse {
    status: { code: number; errorCode: number | null; message: string | null };
    data: unknown;
  }

  export class BakongKHQR {
    generateIndividual(info: IndividualInfo): KHQRResponse;
    generateMerchant(info: MerchantInfo): KHQRResponse;
    static verify(qr: string): { isValid: boolean };
    static decode(qr: string): KHQRResponse;
  }
}
