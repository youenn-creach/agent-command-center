import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/http";
import { assertRealAccountsAllowed } from "@/server/mode";
import { GoogleError, GoogleServiceSchema, startAuth, syncCalendar, syncGmail } from "@/server/connectors/google";

// Derived from the connector's own list, so a new Google service can't be forgotten here.
const Service = GoogleServiceSchema;
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), service: Service }),
  z.object({ op: z.literal("sync"), service: Service }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    if (body.op === "start") {
      assertRealAccountsAllowed("Connecting Google");
      rateLimit("oauth-start", 6);
      return { url: startAuth(ctx, body.service) };
    }
    rateLimit(`sync-${body.service}`, 6);
    if (body.service === "gmail") return await syncGmail(ctx);
    if (body.service === "google-calendar") return await syncCalendar(ctx);
    throw new HttpError(400, "Gmail drafts has nothing to sync: drafts are created only from approved actions.");
  } catch (err) {
    if (err instanceof GoogleError) throw new HttpError(err.code === "NOT_CONFIGURED" ? 400 : err.code === "NOT_CONNECTED" ? 409 : 502, err.message);
    throw err;
  }
});
