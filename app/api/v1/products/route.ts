import { apiError, json } from "@/lib/server/http";
import { getProducts } from "@/lib/server/products";

export const runtime = "nodejs";

export async function GET() {
  try { return json({ data: getProducts() }); }
  catch (error) { return apiError(error); }
}
