import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readJsonBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(415, "Content-Type must be application/json.");
  }
  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > 16_384) throw new ApiError(413, "Request body is too large.");
  return body;
}

export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

export async function readJson(request: Request): Promise<unknown> {
  return parseJson(await readJsonBody(request));
}

export function apiError(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  if (error instanceof ZodError) {
    return json({ error: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ") }, 400);
  }
  console.error("KHQR request failed:", error);
  return json({ error: "The request could not be completed. Check the server configuration and try again." }, 500);
}
