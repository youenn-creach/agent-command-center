import { z } from "zod";
import { connection } from "next/server";
import { checkRequest, errorResponse, rateLimit, readJson } from "@/server/http";
import { getCtx } from "@/server/runtime";
import { streamAnswer } from "@/server/retrieval/knowledge";

const Body = z.object({ retrievalId: z.string().min(1).max(64) });

/**
 * Streams a grounded answer as newline-delimited JSON: {"t":"…"} per token, then
 * {"done":true,"result":…} or {"error":"…"}. Closing the request stops local generation.
 */
export async function POST(req: Request) {
  await connection();
  try {
    checkRequest(req, true);
    rateLimit("answer", 6);
    const { retrievalId } = Body.parse(await readJson(req));
    const ctx = getCtx();
    const encoder = new TextEncoder();
    const events = streamAnswer(ctx, retrievalId, req.signal);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await events.next();
          if (done) return controller.close();
          const line = value.type === "token" ? { t: value.text } : { done: true, result: value.result };
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch (err) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ error: err instanceof Error ? err.message.slice(0, 200) : "Answer failed" })}\n`));
          controller.close();
        }
      },
      async cancel() {
        await events.return(undefined);
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (err) {
    return errorResponse(err);
  }
}
