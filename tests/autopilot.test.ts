import { describe, expect, it } from "vitest";
import { mayAutoRun, type AutoBudget, type AutoFacts, type AutoSetting } from "@/server/autopilot";

// docs/AUTOPILOT_SECURITY_TESTS.md, as a table: every rule of the pure decision function.
const now = new Date("2026-10-15T08:30:00Z");
const on: AutoSetting = { enabled: true, paused: false };
const room: AutoBudget = { lastHour: 0, lastDay: 0, perHour: 3, perDay: 10 };
const event: AutoFacts = { startsAt: "2026-10-16T17:00:00.000Z", endsAt: "2026-10-16T18:00:00.000Z", eventsThatDay: 2 };
const draft: AutoFacts = { knownRecipient: true, namedInRequest: true };

const cases: [string, Parameters<typeof mayAutoRun>, boolean, RegExp?][] = [
  ["a typed event, autopilot on, room in the budget", ["calendar_event", "typed", event, room, on, now], true],
  ["a typed draft to someone written to before, named", ["email_draft", "typed", draft, room, on, now], true],
  // 1. who can ask
  ["an event taken from an email waits", ["calendar_event", "source", event, room, on, now], false, /someone else wrote/],
  ["a draft built from an email waits", ["email_draft", "source", draft, room, on, now], false, /someone else wrote/],
  // 2. what may run
  ["sending mail is never automatic", ["email_reply", "typed", draft, room, on, now], false, /always waits/],
  ["webhooks are never automatic", ["webhook", "typed", {}, room, on, now], false, /always waits/],
  ["off for the kind: ask (the default)", ["calendar_event", "typed", event, room, { enabled: false, paused: false }, now], false, /off/],
  ["paused (kill switch) beats every setting", ["calendar_event", "typed", event, room, { enabled: true, paused: true }, now], false, /paused/],
  ["the hourly budget holds", ["calendar_event", "typed", event, { ...room, lastHour: 3 }, on, now], false, /an hour/],
  ["the daily budget holds", ["calendar_event", "typed", event, { ...room, lastDay: 10 }, on, now], false, /a day/],
  ["more than 60 days away waits", ["calendar_event", "typed", { ...event, startsAt: "2026-12-20T10:00:00.000Z", endsAt: "2026-12-20T11:00:00.000Z" }, room, on, now], false, /60 days/],
  ["longer than 12 hours waits", ["calendar_event", "typed", { ...event, endsAt: "2026-10-17T17:00:00.000Z" }, room, on, now], false, /12 hours/],
  ["a day with 8 events waits", ["calendar_event", "typed", { ...event, eventsThatDay: 8 }, room, on, now], false, /8 events/],
  // 3. facts verified in code
  ["an unchecked date waits", ["calendar_event", "typed", { eventsThatDay: 0 }, room, on, now], false, /could not be checked/],
  ["a date in the past waits", ["calendar_event", "typed", { ...event, startsAt: "2026-10-14T10:00:00.000Z", endsAt: "2026-10-14T11:00:00.000Z" }, room, on, now], false, /past/],
  ["anything ambiguous waits", ["calendar_event", "typed", { ...event, ambiguous: true }, room, on, now], false, /two things/],
  ["a draft to an address never written to waits", ["email_draft", "typed", { ...draft, knownRecipient: false }, room, on, now], false, /haven't written/],
  ["a draft the request doesn't name a person for waits", ["email_draft", "typed", { ...draft, namedInRequest: false }, room, on, now], false, /doesn't name/],
];

describe("mayAutoRun: what may act without a click", () => {
  for (const [name, args, auto, why] of cases) {
    it(name, () => {
      const out = mayAutoRun(...args);
      expect(out.auto).toBe(auto);
      if (!out.auto && why) expect(out.why).toMatch(why);
    });
  }
});

import { draftFacts, eventFacts } from "@/server/autopilot";
import { seededCtx } from "./helpers";

describe("facts autopilot checks", () => {
  it("a draft: the address is in the owner's mail and the request names the person", () => {
    const ctx = seededCtx();
    const sender = (ctx.db.prepare("SELECT sender FROM messages LIMIT 1").get() as { sender: string }).sender;
    const email = sender.match(/<([^>]+)>/)?.[1] ?? sender;
    const name = sender.replace(/\s*<[^>]*>/, "").trim().split(/\s+/)[0];
    expect(draftFacts(ctx, `reply to ${name} that thursday works`, email, name)).toEqual({ knownRecipient: true, namedInRequest: true });
    expect(draftFacts(ctx, "reply to everyone", email, name).namedInRequest).toBe(false);
    expect(draftFacts(ctx, "reply to stranger", "stranger@unknown.example", "Stranger").knownRecipient).toBe(false);
    // Part of a known address is not known: "x" + that address must not pass.
    expect(draftFacts(ctx, `reply to ${name}`, `x${email}`, name).knownRecipient).toBe(false);
  });
  it("an event: a bare hour or a repeat is ambiguous; a clear time isn't", () => {
    expect(eventFacts("add event: call the bank friday at 9", "a", "b", 0).ambiguous).toBe(true);
    expect(eventFacts("add yoga every tuesday at 7pm", "a", "b", 0).ambiguous).toBe(true);
    expect(eventFacts("add event: dentist friday at 15:00", "a", "b", 0).ambiguous).toBe(false);
    expect(eventFacts("add event: dentist friday 3pm", "a", "b", 0).ambiguous).toBe(false);
  });
});
