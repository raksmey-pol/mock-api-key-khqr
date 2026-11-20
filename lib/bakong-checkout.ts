export type BakongCheckoutEvent = { sessionId?: string };

export type BakongCheckoutCloseEvent = {
  reason: "user" | "done";
  paid: boolean;
  sessionId?: string;
};

export type BakongCheckoutOptions = {
  onSuccess?: (event: BakongCheckoutEvent) => void;
  onScanned?: (event: BakongCheckoutEvent) => void;
  onExpired?: (event: BakongCheckoutEvent) => void;
  onClose?: (event: BakongCheckoutCloseEvent) => void;
};

type BakongCheckoutApi = {
  open: (checkoutUrl: string, options?: BakongCheckoutOptions) => { close: () => void };
};

declare global {
  interface Window {
    BakongCheckout?: BakongCheckoutApi;
  }
}

export function isBakongCheckoutReady() {
  return typeof window !== "undefined" && Boolean(window.BakongCheckout);
}

export function waitForBakongCheckout(timeoutMs = 5000): Promise<void> {
  if (isBakongCheckoutReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (isBakongCheckoutReady()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(
          "The Bakong checkout script did not load. Check that CHECKOUT_HOST is reachable and allowed by the CSP, then refresh.",
        ));
      }
    }, 100);
  });
}

export function openBakongCheckout(checkoutUrl: string, options?: BakongCheckoutOptions) {
  if (!isBakongCheckoutReady()) {
    throw new Error("The Bakong checkout script is not ready. Refresh the page and try again.");
  }
  return window.BakongCheckout!.open(checkoutUrl, options);
}
