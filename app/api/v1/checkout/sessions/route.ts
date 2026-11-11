import { z } from "zod";
import {
  checkoutCreateSchema,
  listMerchantSessions,
  mintStandaloneCheckoutSession,
  openApiError,
  openApiJson,
  requireMerchantAuth,
} from "@/lib/server/checkout";
import { ApiError } from "@/lib/server/http";
import { readJson, requestOrigin } from "@/lib/server/http";

export const runtime = "nodejs";

// POST {base}/v1/checkout/sessions — mint a checkout session. Requires the
// merchant bearer token and a UUID Idempotency-Key (integration guide 5).
export async function POST(request: Request) {
  try {
    requireMerchantAuth(request);
    const idempotencyKey = new Headers(request.headers).get("idempotency-key") ?? "";
    const { payload } = mintStandaloneCheckoutSession({
      input: checkoutCreateSchema.parse(await readJson(request)),
      idempotencyKey,
      origin: requestOrigin(request),
    });
    return openApiJson(payload);
  } catch (error) { return openApiError(error); }
}

// GET {base}/v1/checkout/sessions — list or reconcile sessions (section 7.5).
// Supports single or repeated `status`, `since`/`until`/`updated_since` epoch
// seconds, `billNo`, `limit` (max 100) and the opaque `cursor`.
export async function GET(request: Request) {
  try {
    requireMerchantAuth(request);
    const query = new URL(request.url).searchParams;
    const statuses = [
      ...new Set(
        query
          .getAll("status")
          .flatMap((value) => value.split(","))
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    for (const status of statuses) {
      if (!["CREATED", "SCANNED", "SUCCESS", "FAILED", "TIMEOUT", "EXPIRED", "CANCELLED", "PENDING"].includes(status)) {
        throw new ApiError(400, `Unsupported status filter: ${status}.`);
      }
    }
    const epoch = (name: string) => {
      const raw = query.get(name);
      if (raw === null) return undefined;
      const parsed = z.coerce.number().int().nonnegative().max(4_102_444_800).safeParse(raw);
      if (!parsed.success) throw new ApiError(400, `${name} must be a unix timestamp in seconds.`);
      return parsed.data;
    };
    const limitSchema = z.coerce.number().int().min(1).max(100).default(100);
    const limit = limitSchema.safeParse(query.get("limit") ?? undefined);
    if (!limit.success) throw new ApiError(400, "limit must be an integer from 1 to 100.");
    const page = listMerchantSessions({
      statuses: statuses.length ? statuses : undefined,
      since: epoch("since"),
      until: epoch("until"),
      updatedSince: epoch("updated_since"),
      billNo: query.get("billNo") || undefined,
      limit: limit.data,
      cursor: query.get("cursor") || undefined,
    });
    return openApiJson(page);
  } catch (error) { return openApiError(error); }
}
