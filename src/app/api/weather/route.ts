import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/http";
import { clearLocation, LocationSchema, searchLocations, setLocation, WeatherError } from "@/server/connectors/weather";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("search"), query: z.string().max(80) }),
  z.object({ op: z.literal("set"), location: LocationSchema }),
  z.object({ op: z.literal("clear") }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  try {
    if (body.op === "search") {
      rateLimit("weather-search", 10);
      return { results: await searchLocations(body.query) };
    }
    if (body.op === "set") setLocation(ctx, body.location);
    else clearLocation(ctx);
    return { ok: true };
  } catch (err) {
    if (err instanceof WeatherError) throw new HttpError(502, err.message);
    throw err;
  }
});
