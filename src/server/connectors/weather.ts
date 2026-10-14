import { z } from "zod";
import { assertRealAccountsAllowed } from "../mode";
import { getSetting, run, setSetting, type Ctx } from "../db";
import { logActivity } from "../activity";

/**
 * Weather for the briefing, from Open-Meteo (free for non-commercial use, no API key, CC BY 4.0).
 * Read-only. Only a city-level location (coordinates rounded to 0.01°, ~1 km) is sent, to fixed
 * hosts; forecasts are cached for 30 minutes. Like every real service, it starts at access None.
 */

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const CACHE_MS = 30 * 60_000;
export const WEATHER_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)";

export class WeatherError extends Error {}

export const LocationSchema = z.object({
  name: z.string().min(1).max(100),
  admin1: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().max(64).optional(),
});
export type WeatherLocation = z.infer<typeof LocationSchema>;

type Fetcher = (url: string) => Promise<Response>;
const defaultFetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error", headers: { "user-agent": "agent-command-center/0.1" } });

async function getJson<T>(url: string, fetcher: Fetcher): Promise<T> {
  const host = new URL(url).hostname;
  if (host !== "geocoding-api.open-meteo.com" && host !== "api.open-meteo.com") throw new WeatherError("Refusing to call an unexpected host");
  const res = await fetcher(url);
  if (!res.ok) throw new WeatherError(`Weather service returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function searchLocations(query: string, fetcher: Fetcher = defaultFetcher): Promise<WeatherLocation[]> {
  const q = z.string().trim().min(2).max(80).parse(query);
  const data = await getJson<{ results?: WeatherLocation[] }>(`${GEO}?${new URLSearchParams({ name: q, count: "5", language: "en", format: "json" })}`, fetcher);
  return (data.results ?? []).map((r) => LocationSchema.parse({ name: r.name, admin1: r.admin1, country: r.country, latitude: r.latitude, longitude: r.longitude, timezone: r.timezone }));
}

export function getLocation(ctx: Ctx): WeatherLocation | null {
  try {
    return LocationSchema.parse(JSON.parse(getSetting(ctx.db, "weather.location") ?? "null"));
  } catch {
    return null;
  }
}

export function setLocation(ctx: Ctx, input: WeatherLocation) {
  assertRealAccountsAllowed("Weather");
  const loc = LocationSchema.parse(input);
  const rounded = { ...loc, latitude: Math.round(loc.latitude * 100) / 100, longitude: Math.round(loc.longitude * 100) / 100 };
  setSetting(ctx.db, "weather.location", JSON.stringify(rounded));
  setSetting(ctx.db, "weather.cache", "null");
  run(ctx.db, "UPDATE services SET connection_state = 'connected', last_sync_at = NULL WHERE id = 'weather'");
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: "weather", outcome: "info", summary: `Weather location set to ${rounded.name}${rounded.country ? `, ${rounded.country}` : ""}. Access stays as granted.` });
}

export function clearLocation(ctx: Ctx) {
  setSetting(ctx.db, "weather.location", "null");
  setSetting(ctx.db, "weather.cache", "null");
  run(ctx.db, "UPDATE services SET connection_state = 'disconnected', access_level = 'none' WHERE id = 'weather'");
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: "weather", outcome: "info", summary: "Weather location removed" });
}

const CODES: [number[], string][] = [
  [[0], "clear sky"],
  [[1], "mainly clear"],
  [[2], "partly cloudy"],
  [[3], "overcast"],
  [[45, 48], "fog"],
  [[51, 53, 55, 56, 57], "drizzle"],
  [[61, 63, 65, 66, 67], "rain"],
  [[71, 73, 75, 77], "snow"],
  [[80, 81, 82], "rain showers"],
  [[85, 86], "snow showers"],
  [[95, 96, 99], "thunderstorm"],
];
export function describeCode(code: number) {
  return CODES.find(([codes]) => codes.includes(code))?.[1] ?? "mixed conditions";
}

export interface DayForecast {
  date: string;
  summary: string;
  min: number;
  max: number;
  rainChance: number | null;
}

export async function forecast(ctx: Ctx, fetcher: Fetcher = defaultFetcher): Promise<{ location: string; days: DayForecast[]; attribution: string; cached: boolean }> {
  const loc = getLocation(ctx);
  if (!loc) throw new WeatherError("No weather location set (Settings → Weather).");
  const label = `${loc.name}${loc.country ? `, ${loc.country}` : ""}`;
  try {
    const cached = JSON.parse(getSetting(ctx.db, "weather.cache") ?? "null") as { at: number; days: DayForecast[] } | null;
    if (cached && ctx.now().getTime() - cached.at < CACHE_MS) return { location: label, days: cached.days, attribution: WEATHER_ATTRIBUTION, cached: true };
  } catch {
    // ignore a corrupt cache
  }
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: loc.timezone ?? "auto",
    forecast_days: "2",
  });
  const data = await getJson<{ daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max?: (number | null)[] } }>(`${FORECAST}?${params}`, fetcher);
  const d = data.daily;
  if (!d?.time?.length) throw new WeatherError("Weather service returned no forecast");
  const days = d.time.map((date, i) => ({
    date,
    summary: describeCode(d.weather_code[i]),
    min: Math.round(d.temperature_2m_min[i]),
    max: Math.round(d.temperature_2m_max[i]),
    rainChance: d.precipitation_probability_max?.[i] ?? null,
  }));
  setSetting(ctx.db, "weather.cache", JSON.stringify({ at: ctx.now().getTime(), days }));
  run(ctx.db, "UPDATE services SET last_sync_at = ? WHERE id = 'weather'", ctx.now().toISOString());
  return { location: label, days, attribution: WEATHER_ATTRIBUTION, cached: false };
}

/**
 * Up to 7 days for any place ("weather in Barcelona tomorrow"): the place name is looked up with the
 * same Open-Meteo geocoder, then the forecast for its coordinates (rounded to ~1 km). Nothing is stored.
 */
export async function forecastFor(place: string | null, ctx: Ctx, fetcher: Fetcher = defaultFetcher): Promise<{ location: string; days: DayForecast[]; attribution: string }> {
  const loc = place ? (await searchLocations(place, fetcher))[0] : getLocation(ctx);
  if (!loc) throw new WeatherError(place ? `I couldn't find a place called “${place}”.` : "No weather location set (Settings → Weather).");
  const params = new URLSearchParams({
    latitude: String(Math.round(loc.latitude * 100) / 100),
    longitude: String(Math.round(loc.longitude * 100) / 100),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: loc.timezone ?? "auto",
    forecast_days: "7",
  });
  const data = await getJson<{ daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max?: (number | null)[] } }>(`${FORECAST}?${params}`, fetcher);
  const d = data.daily;
  if (!d?.time?.length) throw new WeatherError("Weather service returned no forecast");
  return {
    location: `${loc.name}${loc.admin1 && loc.admin1 !== loc.name ? `, ${loc.admin1}` : ""}${loc.country ? `, ${loc.country}` : ""}`,
    days: d.time.map((date, i) => ({ date, summary: describeCode(d.weather_code[i]), min: Math.round(d.temperature_2m_min[i]), max: Math.round(d.temperature_2m_max[i]), rainChance: d.precipitation_probability_max?.[i] ?? null })),
    attribution: WEATHER_ATTRIBUTION,
  };
}

export function formatForecast(f: { location: string; days: DayForecast[] }) {
  const [today, tomorrow] = f.days;
  const fmt = (x: DayForecast) => `${x.summary}, ${x.min}–${x.max}°C${x.rainChance != null ? `, ${x.rainChance}% rain` : ""}`;
  return `${f.location}: today ${fmt(today)}${tomorrow ? `; tomorrow ${fmt(tomorrow)}` : ""}`;
}
