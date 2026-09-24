import type { CartItem, Currency, OrderItem, Product } from "./types";

export const products: Product[] = [
  { id: "mondulkiri-coffee", name: "Mondulkiri coffee", description: "Locally grown. Slowly roasted. 250g.", category: "PANTRY", price: { USD: 8.5, KHR: 34000 }, color: "#e9dfce", art: "coffee" },
  { id: "everyday-cup", name: "The everyday cup", description: "A little ritual, made by hand. 300ml.", category: "HOME", price: { USD: 12, KHR: 48000 }, color: "#e1e7dd", art: "cup" },
  { id: "market-tote", name: "Market day tote", description: "For your daily finds. 100% cotton.", category: "LIFESTYLE", price: { USD: 9, KHR: 36000 }, color: "#eadfd6", art: "tote" },
  { id: "daily-notes", name: "Room for ideas", description: "Good paper for your next big thing.", category: "STATIONERY", price: { USD: 6.5, KHR: 26000 }, color: "#e1e3ed", art: "notebook" },
  { id: "quiet-candle", name: "A quieter moment", description: "Lemongrass & a little peace. 180g.", category: "HOME", price: { USD: 14, KHR: 56000 }, color: "#ede2d0", art: "candle" },
  { id: "daily-bottle", name: "The go-everywhere", description: "Stay cool. Take the long way. 500ml.", category: "LIFESTYLE", price: { USD: 18, KHR: 72000 }, color: "#dce5e7", art: "bottle" },
];

export const priceLimits: Record<Currency, { min: number; max: number; step: number }> = {
  USD: { min: 0.01, max: 1_000_000, step: 0.01 },
  KHR: { min: 1, max: 1_000_000_000, step: 1 },
};

export function formatMoney(amount: number, currency: Currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: currency === "KHR" ? 0 : 2,
    maximumFractionDigits: currency === "KHR" ? 0 : 2,
  }).format(amount);
}

export function priceOrder(items: CartItem[], currency: Currency, catalog: Product[]) {
  const seen = new Set<string>();
  const orderItems: OrderItem[] = items.map((item) => {
    const product = catalog.find((product) => product.id === item.productId);
    if (!product || seen.has(item.productId)) {
      throw new Error("Choose valid, unique products from the store.");
    }
    seen.add(item.productId);
    return { ...item, name: product.name, unitPrice: product.price[currency] };
  });
  // Calculate in minor units so browser-supplied prices never affect an order.
  const scale = currency === "USD" ? 100 : 1;
  const amount = orderItems.reduce((total, item) => total + Math.round(item.unitPrice * scale) * item.quantity, 0) / scale;
  return { items: orderItems, amount };
}
