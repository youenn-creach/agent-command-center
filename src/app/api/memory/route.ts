import { z } from "zod";
import { handler, HttpError, readJson } from "@/server/http";
import { addFact, deleteFact, MemoryError, updateFact } from "@/server/memory";

const Id = z.string().min(1).max(64);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), text: z.string().max(400) }),
  z.object({ op: z.literal("update"), id: Id, text: z.string().max(400) }),
  z.object({ op: z.literal("delete"), id: Id }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    if (body.op === "add") return addFact(ctx, body.text);
    if (body.op === "update") updateFact(ctx, body.id, body.text);
    else deleteFact(ctx, body.id);
    return { ok: true };
  } catch (err) {
    if (err instanceof MemoryError) throw new HttpError(400, err.message);
    throw err;
  }
});
