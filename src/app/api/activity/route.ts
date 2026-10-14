import { z } from "zod";
import { handler } from "@/server/http";
import { listActivity } from "@/server/activity";

const Kind = z.string().regex(/^[a-z_]{1,40}$/).optional();

/** The activity log, fetched by the Activity page only (not part of every dashboard refresh). */
export const GET = handler(false, async (req, ctx) => {
  const kind = Kind.parse(new URL(req.url).searchParams.get("kind") ?? undefined);
  return listActivity(ctx, 150, kind);
});
