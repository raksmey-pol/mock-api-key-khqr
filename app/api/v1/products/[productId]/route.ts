import { apiError, json, readJson } from "@/lib/server/http";
import { updateProductPrice } from "@/lib/server/products";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    return json({ data: updateProductPrice(productId, await readJson(request)) });
  } catch (error) { return apiError(error); }
}
