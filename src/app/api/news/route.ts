import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/http";
import { addSource, FeedError, refreshFeeds, removeSource, setSourceEnabled } from "@/server/news/feeds";
import { effectiveAccess } from "@/server/policy/engine";
import { one } from "@/server/db";

const Id = z.string().min(1).max(64);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), name: z.string().max(80), url: z.string().max(500) }),
  z.object({ op: z.literal("toggle"), id: Id, enabled: z.boolean() }),
  z.object({ op: z.literal("remove"), id: Id }),
  z.object({ op: z.literal("refresh") }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    switch (body.op) {
      case "add":
        addSource(ctx, body);
        return { ok: true };
      case "toggle":
        setSourceEnabled(ctx, body.id, body.enabled);
        return { ok: true };
      case "remove":
        removeSource(ctx, body.id);
        return { ok: true };
      case "refresh": {
        rateLimit("news-refresh", 4);
        // A manual refresh is done on behalf of the Knowledge agent, so it honours the same grant.
        const svc = one<{ connection_state: string }>(ctx.db, "SELECT connection_state FROM services WHERE id = 'public-news'");
        if (svc?.connection_state !== "connected" || effectiveAccess(ctx, "knowledge", "public-news").level === "none") {
          throw new HttpError(403, "The news service is disconnected or the Knowledge agent has no access to it.");
        }
        return { report: await refreshFeeds(ctx) };
      }
    }
  } catch (err) {
    if (err instanceof FeedError) throw new HttpError(400, err.message);
    throw err;
  }
});
