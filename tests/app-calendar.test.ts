import { describe, expect, it } from "vitest";
import { all, getSetting } from "@/server/db";
import { assertAllowedGoogleRequest, createAppCalendarEvent, handleCallback, SCOPES, startAuth, type Fetcher } from "@/server/connectors/google";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { approveAction, executeAction, proposeAction } from "@/server/approvals";
import { setCalendarMode } from "@/server/calendarMode";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { seededCtx } from "./helpers";

const API = "https://www.googleapis.com/calendar/v3/calendars";

function fakeCalendar() {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  let scope = "";
  let eventStatus = 200;
  const fetcher: Fetcher = async (url, init) => {
    const raw = init?.body ? String(init.body) : "";
    const body = raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", url, body });
    const u = new URL(url);
    if (u.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", refresh_token: "r", expires_in: 3600, scope });
    if (u.pathname === "/calendar/v3/calendars") return Response.json({ id: "acc123@group.calendar.google.com" });
    if (u.pathname.endsWith("/events")) return eventStatus === 200 ? Response.json({ id: body?.id }) : new Response("{}", { status: eventStatus });
    return new Response("{}", { status: 404 });
  };
  return { calls, fetcher, setScope: (s: string) => (scope = s), setEventStatus: (s: number) => (eventStatus = s) };
}

async function connectedApp() {
  const ctx = seededCtx();
  const g = fakeCalendar();
  g.setScope(SCOPES["google-calendar-app"][0]);
  await handleCallback(ctx, { code: "c", state: new URL(startAuth(ctx, "google-calendar-app")).searchParams.get("state") }, g.fetcher);
  setServiceLevel(ctx, "google-calendar-app", "write_with_approval");
  setAgentLevel(ctx, "calendar", "google-calendar-app", "write_with_approval");
  return { ctx, g };
}

const event = { idempotencyId: "act_1", title: "Dentist", startsAt: "2026-10-20T13:00:00.000Z", endsAt: "2026-10-20T14:00:00.000Z", location: "Riverside Dental", timeZone: "Europe/Paris" };

describe("app calendar (calendar.app.created)", () => {
  it("asks Google for the narrow scope only", () => {
    expect(SCOPES["google-calendar-app"]).toEqual(["https://www.googleapis.com/auth/calendar.app.created"]);
  });

  it("can only create its own calendar and add events to it: never primary, no reads, edits or deletes", () => {
    const ok = (m: string, u: string) => () => assertAllowedGoogleRequest("google-calendar-app", m, u);
    expect(ok("POST", API)).not.toThrow();
    expect(ok("POST", `${API}/acc123%40group.calendar.google.com/events`)).not.toThrow();
    expect(ok("POST", `${API}/primary/events`)).toThrow();
    expect(ok("GET", `${API}/acc123%40group.calendar.google.com/events`)).toThrow();
    expect(ok("POST", `${API}/acc123%40group.calendar.google.com/events/abc`)).toThrow();
    expect(ok("POST", "https://www.googleapis.com/calendar/v3/users/me/calendarList")).toThrow();
    // …and the main calendar connection stays read-only.
    expect(() => assertAllowedGoogleRequest("google-calendar", "POST", `${API}/primary/events`)).toThrow();
  });

  it("never targets your primary calendar, even if the stored calendar id is tampered with", async () => {
    const { ctx, g } = await connectedApp();
    // The primary calendar's id is the account's email address.
    for (const tampered of ["primary", "someone@gmail.com", "x@gmail.com"]) {
      ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('gcal.app.calendarId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(tampered);
      g.calls.length = 0;
      await createAppCalendarEvent(ctx, { ...event, idempotencyId: `t-${tampered}` }, g.fetcher);
      const eventPosts = g.calls.filter((c) => c.url.endsWith("/events"));
      expect(eventPosts.every((c) => c.url.includes("%40group.calendar.google.com/"))).toBe(true);
      expect(g.calls.some((c) => c.url.includes("primary") || c.url.includes("gmail.com"))).toBe(false);
    }
    for (const bad of ["someone%40gmail.com", "primary", "abc%40group.calendar.google.com.evil.example"]) {
      expect(() => assertAllowedGoogleRequest("google-calendar-app", "POST", `${API}/${bad}/events`)).toThrow();
    }
  });

  it("creates the calendar once, then events with a stable id (retries can't duplicate)", async () => {
    const { ctx, g } = await connectedApp();
    const out = await createAppCalendarEvent(ctx, event, g.fetcher);
    expect(getSetting(ctx.db, "gcal.app.calendarId")).toBe("acc123@group.calendar.google.com");
    const posts = g.calls.filter((c) => c.method === "POST" && c.url.startsWith(API));
    expect(posts.map((c) => c.url)).toEqual([API, `${API}/acc123%40group.calendar.google.com/events`]);
    expect(posts[1].body).toMatchObject({ id: out.eventId, summary: "Dentist", location: "Riverside Dental", start: { dateTime: event.startsAt, timeZone: "Europe/Paris" } });
    expect(out.eventId).toMatch(/^[0-9a-v]{32}$/);
    // Same action again: same id; Google answers 409 (already exists) and that counts as done.
    g.setEventStatus(409);
    expect((await createAppCalendarEvent(ctx, event, g.fetcher)).eventId).toBe(out.eventId);
    expect(all(ctx.db, "SELECT id FROM events WHERE source = 'google-calendar-app'")).toHaveLength(1);
  });

  it("all-day events use dates in the user's time zone", async () => {
    const { ctx, g } = await connectedApp();
    await createAppCalendarEvent(ctx, { ...event, allDay: true, startsAt: "2026-10-23T22:00:00.000Z", endsAt: "2026-10-24T22:00:00.000Z" }, g.fetcher);
    expect(g.calls.at(-1)!.body).toMatchObject({ start: { date: "2026-10-24" }, end: { date: "2026-10-25" } });
  });

  it("“add event” in app mode proposes the event; approving it adds it (one click in the card)", async () => {
    const { ctx, g } = await connectedApp();
    const r = await runCommand(ctx, "add event: dentist tuesday 3pm at Riverside Dental", workflows);
    expect(r.approval).toMatchObject({ calendar: "Agent Command Center" });
    expect(g.calls.some((c) => c.url.endsWith("/events"))).toBe(false); // nothing written before approval
    approveAction(ctx, r.approval!.actionId, r.approval!.hash, "user");
    const { appCalendarConnector } = await import("@/server/approvals");
    const done = await executeAction(ctx, r.approval!.actionId, appCalendarConnector(ctx, g.fetcher));
    expect(done.status).toBe("executed");
    expect(g.calls.filter((c) => c.url.endsWith("/events"))).toHaveLength(1);
  });

  it("asking again after a dismissal or failure makes a fresh proposal, not the dead one", async () => {
    const { ctx } = await connectedApp();
    const first = await runCommand(ctx, "add event: dentist tuesday 3pm", workflows);
    const same = await runCommand(ctx, "add event: dentist tuesday 3pm", workflows); // double click, same minute
    expect(same.approval!.actionId).toBe(first.approval!.actionId);
    ctx.db.prepare("UPDATE actions SET status = 'dismissed' WHERE id = ?").run(first.approval!.actionId);
    ctx.setNow(new Date(ctx.now().getTime() + 5 * 60_000));
    const again = await runCommand(ctx, "add event: dentist tuesday 3pm", workflows);
    expect(again.approval!.actionId).not.toBe(first.approval!.actionId);
    approveAction(ctx, again.approval!.actionId, again.approval!.hash, "user"); // approvable, not stuck
  });

  it("the toggle switches back to “add it myself” (no action, just Google's page)", async () => {
    const { ctx } = await connectedApp();
    setCalendarMode(ctx, "link");
    const r = await runCommand(ctx, "add event: dentist tuesday 3pm", workflows);
    expect(r.approval).toBeUndefined();
    expect(r.event?.googleUrl).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    expect(all(ctx.db, "SELECT id FROM actions WHERE service_id = 'google-calendar-app'")).toEqual([]);
  });

  it("without the app calendar connected, falls back to the link and says how to enable it", async () => {
    const ctx = seededCtx();
    const r = await runCommand(ctx, "add event: dentist tuesday 3pm", workflows);
    expect(r.approval).toBeUndefined();
    expect(r.reply).toMatch(/connect “Google Calendar: app calendar”/);
  });

  it("the main Google Calendar still can't receive an event, even proposed directly", () => {
    const ctx = seededCtx();
    expect(() =>
      proposeAction(ctx, { agentId: "calendar", serviceId: "google-calendar", kind: "calendar_event", title: "x", payload: { calendar: "primary", title: "x", startsAt: "2026-10-14T10:00:00+02:00", endsAt: "2026-10-14T11:00:00+02:00" }, idempotencyKey: "main-cal" }),
    ).toThrow();
  });
});

import { appCalendarConnector } from "@/server/approvals";
import { undoDone } from "@/server/autopilot";

describe("Undo of an autopilot event in the app calendar", () => {
  async function autopilotEvent() {
    const { ctx, g } = await connectedApp();
    let deleteStatus = 204;
    const deletes: string[] = [];
    const fetcher: Fetcher = async (url, init) => {
      if (init?.method === "DELETE") {
        deletes.push(url);
        await new Promise((r) => setTimeout(r, 5)); // Google takes a moment: two clicks overlap
        return new Response(null, { status: deleteStatus });
      }
      return g.fetcher(url, init);
    };
    const p = proposeAction(ctx, { agentId: "calendar", serviceId: "google-calendar-app", kind: "calendar_event", title: "Calendar: Dentist", payload: { calendar: "Agent Command Center", title: "Dentist", startsAt: event.startsAt, endsAt: event.endsAt }, idempotencyKey: "auto-1" });
    approveAction(ctx, p.id, p.payload_hash, "autopilot");
    await executeAction(ctx, p.id, appCalendarConnector(ctx, fetcher));
    return { ctx, id: p.id, fetcher, deletes, setDelete: (s: number) => (deleteStatus = s) };
  }

  it("two Undo clicks at once delete the event once, at the exact path of the event the app made", async () => {
    const { ctx, id, fetcher, deletes } = await autopilotEvent();
    const out = await Promise.all([undoDone(ctx, "action", id, fetcher), undoDone(ctx, "action", id, fetcher)]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(/\/calendars\/acc123%40group\.calendar\.google\.com\/events\/[0-9a-f]{32}$/);
    expect(out.map((o) => o.summary).filter((s) => s === "Already undone.")).toHaveLength(1);
  });

  it("if Google refuses, nothing is marked undone and Undo can be tried again", async () => {
    const { ctx, id, fetcher, setDelete } = await autopilotEvent();
    setDelete(500);
    await expect(undoDone(ctx, "action", id, fetcher)).rejects.toThrow(/refused to remove/);
    expect(getActionUndone(ctx, id)).toBeNull();
    setDelete(204);
    await undoDone(ctx, "action", id, fetcher);
    expect(getActionUndone(ctx, id)).toBeTruthy();
  });
});

function getActionUndone(ctx: { db: Parameters<typeof import("@/server/db").one>[0] }, id: string) {
  return (ctx.db.prepare("SELECT undone_at FROM actions WHERE id = ?").get(id) as { undone_at: string | null }).undone_at;
}
