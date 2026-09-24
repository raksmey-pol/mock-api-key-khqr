import { apiError } from "@/lib/server/http";
import { getTransaction, md5Schema } from "@/lib/server/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const md5 = md5Schema.parse(new URL(request.url).searchParams.get("md5"));
    getTransaction(md5);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let lastVersion = "";
        let ticks = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          request.signal.removeEventListener("abort", stop);
        };
        const stop = () => {
          if (closed) return;
          cleanup();
          controller.close();
        };
        const send = () => {
          if (closed) return;
          try {
            const transaction = getTransaction(md5);
            const version = `${transaction.updatedAt}:${transaction.status}`;
            if (lastVersion !== version) {
              controller.enqueue(encoder.encode(`event: transaction\ndata: ${JSON.stringify(transaction)}\n\n`));
              lastVersion = version;
            }
            if (transaction.status !== "pending") return stop();
            ticks++;
            if (ticks % 15 === 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            // EventSource reconnects automatically; bound the lifetime of each request.
            if (ticks >= 55) stop();
          } catch { stop(); }
        };
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) return stop();
        send();
        if (!closed) timer = setInterval(send, 1000);
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    } });
  } catch (error) { return apiError(error); }
}
