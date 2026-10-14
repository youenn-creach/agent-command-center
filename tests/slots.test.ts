import { describe, expect, it } from "vitest";
import { findFreeSlots, formatSlots, workingHoursFromFacts } from "@/server/agents/slots";
import { classify, runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { all, run } from "@/server/db";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { addFact } from "@/server/memory";
import { seededCtx } from "./helpers";

const TZ = "Europe/Paris";
// Monday 12 October 2026, 08:00 in Paris.
const NOW = new Date("2026-10-12T06:00:00Z");
const at = (local: string) => new Date(`${local}:00+02:00`).toISOString();

describe("free slots", () => {
  it("offers one slot per weekday, inside working hours, around busy time (with a buffer)", () => {
    const busy = [
      { starts_at: at("2026-10-12T10:00"), ends_at: at("2026-10-12T12:00") }, // Monday morning: earliest is 10:00 (2h notice) → busy until 12:00 (+15 min)
      { starts_at: at("2026-10-13T09:00"), ends_at: at("2026-10-13T18:00") }, // Tuesday: fully booked
    ];
    const slots = formatSlots(findFreeSlots(busy, NOW, TZ, { durationMin: 30 }), TZ);
    expect(slots).toEqual(["Monday 12 October, 12:30–13:00", "Wednesday 14 October, 09:00–09:30", "Thursday 15 October, 09:00–09:30"]);
  });

  it("skips weekends and respects working hours from About me", () => {
    const friday = new Date("2026-10-16T15:00:00Z"); // Friday 17:00 in Paris
    const hours = workingHoursFromFacts(["I like tea", "I work 10:00-16:00 on weekdays"]);
    expect(hours).toEqual({ workStart: 600, workEnd: 960 });
    const slots = formatSlots(findFreeSlots([], friday, TZ, { durationMin: 60, count: 2, ...hours! }), TZ);
    expect(slots).toEqual(["Monday 19 October, 10:00–11:00", "Tuesday 20 October, 10:00–11:00"]);
    expect(workingHoursFromFacts(["I work 9-5"])).toEqual({ workStart: 540, workEnd: 1020 });
  });

  it("is reachable from Ctrl+K", () => {
    expect(classify("propose times to Maria")).toEqual({ intent: "slots", target: "Maria", query: undefined });
    expect(classify("find time with jordan for 1h")).toEqual({ intent: "slots", target: "jordan", query: "60" });
    expect(classify("suggest some slots to Ana for 45 min")).toEqual({ intent: "slots", target: "Ana", query: "45" });
  });

  it("drafts a reply with the slots to the person's latest message, for approval", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-calendar", "read");
    setAgentLevel(ctx, "calendar", "demo-calendar", "read");
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    addFact(ctx, "I work 9:00-17:00");
    const r = await runCommand(ctx, "propose times to maria", workflows);
    expect(r.intent).toBe("slots");
    expect(r.items?.length).toBe(3);
    const action = all<{ status: string; payload: string }>(ctx.db, "SELECT status, payload FROM actions WHERE id = ?", r.ref!.actionId!)[0];
    expect(action.status).toBe("proposed");
    expect(JSON.parse(action.payload)).toMatchObject({ to: "maria.lopez@example.com", subject: "Re: Saturday hike — are you in?", body: expect.stringContaining(r.items![0].title) });
  });

  it("without the calendar permission, says what is missing", async () => {
    const ctx = seededCtx();
    run(ctx.db, "DELETE FROM agent_permissions WHERE agent_id = 'calendar'");
    const r = await runCommand(ctx, "propose times to maria", workflows);
    expect(r.reply).toMatch(/needs Read on your calendar/);
  });
});
