import { z } from "zod";
import { handler, HttpError, readJson } from "@/server/http";
import { deleteReminder, ReminderError, setReminderDone } from "@/server/reminders";

const Id = z.string().min(1).max(64);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("done"), id: Id, done: z.boolean() }),
  z.object({ op: z.literal("delete"), id: Id }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    if (body.op === "done") setReminderDone(ctx, body.id, body.done);
    else deleteReminder(ctx, body.id);
    return { ok: true };
  } catch (err) {
    if (err instanceof ReminderError) throw new HttpError(404, err.message);
    throw err;
  }
});
