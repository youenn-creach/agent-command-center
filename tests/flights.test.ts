import { afterEach, describe, expect, it, vi } from "vitest";
import { all, run } from "@/server/db";
import { reloadConfig } from "@/server/config";
import { classify, runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { parseFlightSubject } from "@/server/agents/flights";
import { seededCtx } from "./helpers";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";

// Formats seen in real confirmations; routes, dates and references here are made up.
const RECEIVED = new Date("2026-09-29T10:00:00Z");
const legs = (subject: string, sender = "Volotea <noreply@notifications.volotea.com>") =>
  parseFlightSubject(subject, sender, RECEIVED, "Europe/Madrid").map((l) => `${l.from}-${l.to} ${l.date.y}-${l.date.m}-${l.date.d}${l.time ? ` ${l.time}` : ""} ${l.airline} ${l.ref}`);

describe("flights from booking subjects", () => {
  it("reads the route, date, airline and booking reference in English, French and Spanish", () => {
    expect(legs("   Volotea •  Your booking confirmation: LYS-OPO • 14 March 2027 • K7QZ2X")).toEqual(["LYS-OPO 2027-3-14 Volotea K7QZ2X"]);
    expect(legs("Volotea • Confirmation de votre réservation : MRS-NTE • 11 avril 2027 • P4LM8R")).toEqual(["MRS-NTE 2027-4-11 Volotea P4LM8R"]);
    expect(legs("Confirmación de tu reserva QWERTY -  OPO-VLC 19 noviembre", "Vueling <x@comms.vueling.com>")).toEqual(["OPO-VLC 2026-11-19 Vueling QWERTY"]);
  });

  it("splits a return trip into its legs, and puts a date without a year after the email", () => {
    expect(legs("Confirmación de tu reserva ZXCVB1 -  VLC-TFN 05 marzo, TFN-VLC 09 marzo", "Vueling <x@comms.vueling.com>")).toEqual([
      "VLC-TFN 2027-3-5 Vueling ZXCVB1",
      "TFN-VLC 2027-3-9 Vueling ZXCVB1",
    ]);
  });

  it("keeps a departure time when the subject has one; no route or no date means no flight", () => {
    expect(legs("Your e-ticket: Lisbon (BCN-LIS), Fri 7 Nov, 07:40", "Example Air <booking@air.example>")).toEqual(["BCN-LIS 2026-11-7 07:40 Example Air null"]);
    expect(legs("Your booking is confirmed")).toEqual([]);
    expect(legs("Check-in is open for BCN-LIS")).toEqual([]);
  });
});

describe("Ctrl+K: flights to the calendar", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    reloadConfig();
  });

  it("routes requests about flights and the calendar, in several languages, and never answers them with today's agenda", () => {
    expect(classify("add my booked flights into my calendar").intent).toBe("flights");
    expect(classify("check my emails, and add any booked flight that you see in there into my calendar as an event").intent).toBe("flights");
    expect(classify("ajoute mes vols dans mon agenda").intent).toBe("flights");
    expect(classify("añade mis vuelos al calendario").intent).toBe("flights");
    expect(classify("add lunch with Sam into my calendar")).toMatchObject({ intent: "event", query: "lunch with Sam" });
    expect(classify("please add the plumber thing to my calendar for me")).toMatchObject({ intent: "help", query: "calendar" });
    expect(classify("what's on my calendar today?").intent).toBe("today");
  });

  it("prepares one card per upcoming flight, and leaves out a flight already in the calendar", async () => {
    vi.stubEnv("ACC_TIMEZONE", "Europe/Madrid");
    reloadConfig();
    const ctx = seededCtx(new Date("2026-10-14T08:00:00Z"));
    const out = await runCommand(ctx, "add my flights to my calendar", workflows);
    expect(out.intent).toBe("flights");
    expect(out.events?.map((e) => e.event.title)).toEqual(["Flight BCN → LIS 07:40 (Example Air)"]);
    expect(out.events?.[0].event).toMatchObject({ allDay: true, start: "2026-11-07" });
    expect(out.events?.[0].event.googleUrl).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    expect(all(ctx.db, "SELECT * FROM requests WHERE intent = 'flights'")).toHaveLength(1);

    run(ctx.db, "INSERT INTO events (id, title, starts_at, ends_at, location) VALUES ('e-fl', 'Flight to Lisbon', '2026-11-07T06:40:00Z', '2026-11-07T09:00:00Z', NULL)");
    const again = await runCommand(ctx, "add my flights to my calendar", workflows);
    expect(again.events ?? []).toEqual([]);
    expect(again.reply).toMatch(/already in your calendar/);
  });

  it("proposes each flight for approval when the app adds events itself (demo calendar here)", async () => {
    vi.stubEnv("ACC_MODE", "demo");
    reloadConfig();
    const ctx = seededCtx(new Date("2026-10-14T08:00:00Z"));
    setServiceLevel(ctx, "demo-calendar", "write_with_approval");
    setAgentLevel(ctx, "calendar", "demo-calendar", "write_with_approval");
    const out = await runCommand(ctx, "add my flights to my calendar", workflows);
    const approval = out.events?.[0].approval;
    expect(approval).toBeTruthy();
    const action = all<{ status: string; kind: string; service_id: string }>(ctx.db, "SELECT status, kind, service_id FROM actions WHERE id = ?", approval!.actionId)[0];
    expect(action).toEqual({ status: "proposed", kind: "calendar_event", service_id: "demo-calendar" });
    // Asking again reuses the proposal instead of piling up duplicates.
    const again = await runCommand(ctx, "add my flights to my calendar", workflows);
    expect(again.events?.[0].approval?.actionId).toBe(approval!.actionId);
  });
});
