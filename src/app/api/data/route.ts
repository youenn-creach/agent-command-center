import { z } from "zod";
import { handler, readJson } from "@/server/http";
import { clearUserData, exportUserData } from "@/server/userData";

export const GET = handler(false, async (_req, ctx) => exportUserData(ctx));

const Body = z.object({ op: z.literal("clear-user-data") });

export const POST = handler(true, async (req, ctx) => {
  Body.parse(await readJson(req));
  await clearUserData(ctx);
  return { ok: true };
});
