import { describe, expect, it } from "vitest";
import { all } from "@/server/db";
import { clearLocation, describeCode, forecast, formatForecast, getLocation, searchLocations, setLocation } from "@/server/connectors/weather";
import { callTool } from "@/server/tools/registry";
import { RunBudget } from "@/server/tools/budget";
import { PolicyError } from "@/server/policy/engine";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { seededCtx } from "./helpers";

function fakeMeteo() {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    const body = url.includes("geocoding")
      ? { results: [{ name: "Madrid", admin1: "Madrid", country: "Spain", latitude: 40.4165, longitude: -3.70256, timezone: "Europe/Madrid" }] }
      : { daily: { time: ["2026-10-12", "2026-10-13"], weather_code: [2, 61], temperature_2m_max: [26.6, 21.2], temperature_2m_min: [11.6, 13.4], precipitation_probability_max: [0, 70] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { urls, fetcher };
}

describe("weather", () => {
  it("geocodes, stores a rounded location, and starts with access None", async () => {
    const ctx = seededCtx();
    const m = fakeMeteo();
    const [loc] = await searchLocations("Madrid", m.fetcher);
    setLocation(ctx, loc);
    expect(getLocation(ctx)).toMatchObject({ latitude: 40.42, longitude: -3.7 });
    const svc = all<{ connection_state: string; access_level: string }>(ctx.db, "SELECT connection_state, access_level FROM services WHERE id = 'weather'")[0];
    expect(svc).toEqual({ connection_state: "connected", access_level: "none" });
  });

  it("only sends rounded coordinates, caches for 30 minutes, and formats a briefing line", async () => {
    const ctx = seededCtx();
    const m = fakeMeteo();
    setLocation(ctx, { name: "Madrid", country: "Spain", latitude: 40.416512, longitude: -3.702561, timezone: "Europe/Madrid" });
    const f = await forecast(ctx, m.fetcher);
    await forecast(ctx, m.fetcher);
    expect(m.urls).toHaveLength(1);
    expect(m.urls[0]).toContain("latitude=40.42");
    expect(m.urls[0]).not.toContain("40.4165");
    expect(formatForecast(f)).toBe("Madrid, Spain: today partly cloudy, 12–27°C, 0% rain; tomorrow rain, 13–21°C, 70% rain");
    expect(describeCode(95)).toBe("thunderstorm");
  });

  it("agents need Read on the service and as an agent grant", async () => {
    const ctx = seededCtx();
    setLocation(ctx, { name: "Madrid", latitude: 40.42, longitude: -3.7 });
    await expect(callTool(ctx, "calendar", "weather.forecast", {}, new RunBudget(2, 5000))).rejects.toThrow(PolicyError);
    setServiceLevel(ctx, "weather", "read");
    setAgentLevel(ctx, "calendar", "weather", "read");
    expect(() => setServiceLevel(ctx, "weather", "prepare")).toThrow(/at most Read/);
  });

  it("removing the location disconnects and resets access", () => {
    const ctx = seededCtx();
    setLocation(ctx, { name: "Madrid", latitude: 40.42, longitude: -3.7 });
    setServiceLevel(ctx, "weather", "read");
    clearLocation(ctx);
    expect(getLocation(ctx)).toBeNull();
    expect(all<{ access_level: string }>(ctx.db, "SELECT access_level FROM services WHERE id = 'weather'")[0].access_level).toBe("none");
  });

  it("a crafted search query cannot change the host or inject parameters", async () => {
    const m = fakeMeteo();
    await searchLocations("Madrid&count=500&host=evil.example", m.fetcher);
    const url = new URL(m.urls[0]);
    expect(url.hostname).toBe("geocoding-api.open-meteo.com");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.get("name")).toBe("Madrid&count=500&host=evil.example");
  });
});
