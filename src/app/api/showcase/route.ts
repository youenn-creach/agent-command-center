import { z } from "zod";
import { assertDemoResetAllowed } from "@/server/mode";
import { handler, readJson } from "@/server/http";
import { setSetting } from "@/server/db";
import { logActivity } from "@/server/activity";
import { resetDemo } from "@/server/seed/seed";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("consent"), value: z.boolean() }),
  z.object({ op: z.literal("reset") }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  if (body.op === "consent") {
    setSetting(ctx.db, "showcase.live_consent", String(body.value));
    logActivity(ctx, {
      actor: "user",
      kind: "system",
      outcome: "info",
      summary: body.value
        ? "Enabled Atlas + Voyage live mode (demo corpus and notes shared one by one, free-tier usage confirmed by user)"
        : "Disabled Atlas + Voyage live mode",
    });
    return { ok: true };
  }
  assertDemoResetAllowed();
  resetDemo(ctx);
  return { ok: true };
});
