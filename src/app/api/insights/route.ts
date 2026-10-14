import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/http";
import { InsightError, proposeNudge, refreshInsights, remindAboutBooking, runSubscriptionAudit } from "@/server/insights";
import { ReminderError } from "@/server/reminders";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("refresh") }),
  z.object({ op: z.literal("audit-subscriptions") }),
  z.object({ op: z.literal("nudge"), threadId: z.string().regex(/^[\w-]{1,64}$/) }),
  z.object({ op: z.literal("remind"), bookingId: z.string().regex(/^[\w-]{1,80}$/), dueAt: z.iso.datetime({ offset: true }).optional() }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    if (body.op === "refresh") {
      rateLimit("insights-refresh", 4);
      return await refreshInsights(ctx);
    }
    if (body.op === "audit-subscriptions") {
      rateLimit("insights-audit", 2);
      return await runSubscriptionAudit(ctx);
    }
    if (body.op === "nudge") return await proposeNudge(ctx, body.threadId);
    return { reminderId: remindAboutBooking(ctx, body.bookingId, body.dueAt) };
  } catch (err) {
    if (err instanceof InsightError || err instanceof ReminderError) throw new HttpError(400, err.message);
    throw err;
  }
});
