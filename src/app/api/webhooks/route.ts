import { z } from "zod";
import { handler, HttpError, readJson } from "@/server/http";
import { addWebhook, removeWebhook, WebhookError, WebhookInputSchema } from "@/server/connectors/webhooks";
import { FeedError } from "@/server/news/feeds";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), input: WebhookInputSchema }),
  z.object({ op: z.literal("remove"), id: z.string().regex(/^hook-[a-z0-9-]{1,40}$/) }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    if (body.op === "add") return { id: addWebhook(ctx, body.input) };
    removeWebhook(ctx, body.id);
    return { ok: true };
  } catch (err) {
    if (err instanceof WebhookError || err instanceof FeedError) throw new HttpError(400, err.message.replace("feeds", "webhooks"));
    throw err;
  }
});
