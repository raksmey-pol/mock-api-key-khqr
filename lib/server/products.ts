import { z } from "zod";
import { priceLimits, products } from "../catalog";
import { ApiError } from "./http";
import { readProductPrices, saveProductPrice } from "./store";

const priceSchema = z.discriminatedUnion("currency", [
  z.object({
    currency: z.literal("USD"),
    price: z.number().min(priceLimits.USD.min).max(priceLimits.USD.max)
      .multipleOf(0.01, "USD prices must have at most two decimal places."),
  }).strict(),
  z.object({
    currency: z.literal("KHR"),
    price: z.number().int("KHR prices must be whole riel.").min(priceLimits.KHR.min).max(priceLimits.KHR.max),
  }).strict(),
]);

export function getProducts() {
  const catalog = new Map(products.map((product) => [product.id, { ...product, price: { ...product.price } }]));
  for (const saved of readProductPrices()) {
    const product = catalog.get(saved.productId);
    if (product) product.price[saved.currency] = saved.price;
  }
  return [...catalog.values()];
}

export function updateProductPrice(productId: string, body: unknown) {
  if (!products.some((product) => product.id === productId)) throw new ApiError(404, "Product not found.");
  const input = priceSchema.parse(body);
  saveProductPrice(productId, input.currency, input.price);
  return getProducts().find((product) => product.id === productId)!;
}
