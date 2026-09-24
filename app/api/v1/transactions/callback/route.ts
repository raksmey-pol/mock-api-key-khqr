import { handleCallback } from "@/lib/server/webhook";

export const runtime = "nodejs";

export const POST = handleCallback;
