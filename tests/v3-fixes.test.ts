import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadConfig } from "@/server/config";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { quickRoute } from "@/server/agents/assistant";
import { parseEventRequest } from "@/server/agents/eventParse";
import { all } from "@/server/db";
import type { LlmProvider } from "@/server/llm";
import { seededCtx } from "./helpers";

// Failures of the held-out set v3 (run 2026-10-18 on c6), now tuning material: each request goes through the real command
// path with a model that answers the WRONG route the real model gave, so the fix is the app's, not the model's luck.
const world = () => {
  vi.stubEnv("ACC_TIMEZONE", "Europe/Madrid");
  reloadConfig();
  return seededCtx(new Date("2026-10-15T08:30:00Z")); // Thu 15 Oct 2026, 10:30 Madrid
};
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
});
const routedAs = (skill: string, args: Record<string, unknown> = {}): LlmProvider => ({ id: "f", label: "f", generate: async () => ({ text: JSON.stringify({ skill, args }), model: "f", ms: 1 }) });
const madrid = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).slice(0, 16);
const reminders = (ctx: ReturnType<typeof world>) => all<{ text: string; due_at: string | null }>(ctx.db, "SELECT text, due_at FROM reminders ORDER BY id");

describe("a bare hour before the task is the time", () => {
  const now = new Date("2026-10-15T08:30:00Z");
  const at = (t: string) => {
    const p = parseEventRequest(t, now, "Europe/Madrid", 9 * 60);
    return "error" in p ? p.error : `${p.title} | ${madrid(p.startsAt)}`;
  };
  it("'tonight at 9 to…', 'at 3 to…': the hour, and it leaves the title", () => {
    expect(at("tonight at 9 to lock the bike")).toBe("To lock the bike | 2026-10-15 21:00");
    expect(at("at 3 to call the bank")).toBe("To call the bank | 2026-10-15 15:00");
    expect(at("tomorrow at 9 to call")).toBe("To call | 2026-10-16 09:00");
  });
  it("never a range read as one hour ('at 2 to 4')", () => {
    expect(at("meeting at 2 to 4")).toMatch(/When is it/);
  });
});

describe("reminders with the time before the task", () => {
  it("'remind me tonight at 9 to lock the bike': 21:00, titled with the task", async () => {
    const ctx = world();
    expect(quickRoute("remind me tonight at 9 to lock the bike")?.skill).toBe("reminder");
    await runCommand(ctx, "remind me tonight at 9 to lock the bike", workflows, routedAs("agenda"));
    const [r] = reminders(ctx);
    expect(r.text).toBe("Lock the bike");
    expect(madrid(r.due_at!)).toBe("2026-10-15 21:00");
  });
  it("'remind me friday to buy snacks' is a reminder without the model; 'remind me what…' and anchors are not caught", () => {
    expect(quickRoute("remind me friday to buy snacks")?.skill).toBe("reminder");
    expect(quickRoute("remind me what time the flight is")).toBeNull();
    expect(quickRoute("remind me the day before my flight to check in")).toBeNull();
    expect(quickRoute("remind me 3 days before the insurance renews to compare quotes")).toBeNull();
  });
  it("two asks: 'where's lunch and remind me at 3 to call the bank' sets 15:00", async () => {
    const ctx = world();
    const r = await runCommand(ctx, "where's lunch and remind me at 3 to call the bank", workflows, routedAs("agenda"));
    expect(r.reply).toMatch(/Lumen/);
    const [rem] = reminders(ctx);
    expect(rem.text).toMatch(/call the bank/i);
    expect(madrid(rem.due_at!)).toBe("2026-10-15 15:00");
  });
  it("two asks: 'what's on saturday and remind me friday to buy snacks' sets Friday 09:00, no question back", async () => {
    const ctx = world();
    const r = await runCommand(ctx, "what's on saturday and remind me friday to buy snacks", workflows, routedAs("agenda"));
    expect(r.asked).toBeFalsy();
    const [rem] = reminders(ctx);
    expect(rem.text).toMatch(/snacks/i);
    expect(madrid(rem.due_at!)).toBe("2026-10-16 09:00");
  });
  it("'the day before the long run to get my gear ready': the task is the reminder, even routed as from email", async () => {
    const ctx = world();
    await runCommand(ctx, "remind me the day before the long run to get my gear ready", workflows, routedAs("reminder_from_email", { query: "long run" }));
    const [rem] = reminders(ctx);
    expect(rem.text).toMatch(/^Get my gear ready \(before Long run/);
    expect(madrid(rem.due_at!)).toMatch(/^2026-10-17/);
  });
});

describe("a question about a calendar event goes to the calendar, whatever the model picked", () => {
  it("'where do I drop off my bike' routed as trips: the bike shop", async () => {
    const r = await runCommand(world(), "where do I drop off my bike", workflows, routedAs("trips"));
    expect(r.intent).toBe("agenda");
    expect(r.reply).toMatch(/Spokes|Canal Street/);
  });
  it("'where is the spanish exchange' routed as trips: the library café", async () => {
    const r = await runCommand(world(), "where is the spanish exchange", workflows, routedAs("trips"));
    expect(r.reply).toMatch(/Library caf/i);
  });
  it("'how long does the garden committee go on for' routed as notes: its length", async () => {
    const r = await runCommand(world(), "how long does the garden committee go on for", workflows, routedAs("notes_search", { query: "garden committee" }));
    expect(r.reply).toMatch(/lasts 1 h 30 min/);
    expect(r.reply).toMatch(/18:00–19:30/);
  });
  it("trips that are trips stay trips; a note with no event stays a note", async () => {
    expect((await runCommand(world(), "where am I staying in lisbon", workflows, routedAs("trips"))).intent).toBe("trips");
    expect((await runCommand(world(), "how long would quote A take", workflows, routedAs("notes_search", { query: "quote A" }))).intent).toBe("notes");
  });
});

describe("bills are in the mail, whichever summary skill the model picked", () => {
  for (const skill of ["agenda", "inbox_review", "waiting_on", "weekly_review", "priorities"]) {
    it(`'what bills do I have coming up' routed as ${skill}: a mail question`, async () => {
      expect((await runCommand(world(), "what bills do I have coming up", workflows, routedAs(skill))).intent).toBe("email_question");
    });
  }
  it("'who do I owe a reply to' stays a waiting-on question", async () => {
    expect((await runCommand(world(), "who do I owe a reply to", workflows, routedAs("waiting_on"))).intent).toBe("waiting_on");
  });
});

import { retrieve } from "@/server/retrieval/knowledge";
import { stubLlm } from "./helpers";
describe("notes are found with the search words and answered with the user's question", () => {
  it("'how long does quote B take': the model reads the question, not 'kitchen budget quote B time'", async () => {
    const llm = stubLlm("Four weeks [1].");
    const res = await retrieve(world(), { query: "kitchen budget quote B time", provider: "lexical", k: 3, answer: true, question: "how long does quote B take" }, llm, "chief_of_staff");
    expect(res.passages[0]?.title).toMatch(/Kitchen/);
    expect(llm.calls[0].user).toMatch(/how long does quote B take/);
    expect(llm.calls[0].user).not.toMatch(/kitchen budget quote B time/);
  });
  it("without a question, the query is the question (as before)", async () => {
    const llm = stubLlm("x [1]");
    await retrieve(world(), { query: "kitchen quotes", provider: "lexical", k: 3, answer: true }, llm, "chief_of_staff");
    expect(llm.calls[0].user).toMatch(/kitchen quotes/);
  });
});

import { splitAsks } from "@/server/agents/command";
// Failures of the held-out set v4 (run 2026-10-18 on c7), now tuning material.
describe("v4: titles, trips, questions and 'if not'", () => {
  const now = new Date("2026-10-15T08:30:00Z");
  const title = (t: string) => {
    const p = parseEventRequest(t, now, "Europe/Madrid");
    return "error" in p ? p.error : `${p.title} | ${madrid(p.startsAt)}`;
  };
  it("a part of the day stays in the title when an exact time is given", () => {
    expect(title("the parents evening on the 22nd at 7pm")).toBe("Parents evening | 2026-10-22 19:00");
    expect(title("the morning run tomorrow at 7am")).toBe("Morning run | 2026-10-16 07:00");
    // ...but a day with it is a time: "friday evening at 8" is 20:00, and without a time it gives the hour.
    expect(title("dinner friday evening at 8")).toBe("Dinner | 2026-10-16 20:00");
    expect(title("drinks friday evening")).toBe("Drinks | 2026-10-16 18:00");
  });
  it("'book in a dentist cleaning for december 2 at 4pm' is an event, titled", async () => {
    const r = await runCommand(world(), "book in a dentist cleaning for december 2 at 4pm", workflows, routedAs("add_event"));
    expect(r.event?.title).toMatch(/dentist cleaning/i);
  });
  it("trips only for travel: 'which route is maria planning' goes to the mail; 'how many nights is the alfama booking' to trips", async () => {
    expect((await runCommand(world(), "which route is maria planning", workflows, routedAs("trips"))).intent).toBe("email_question");
    expect((await runCommand(world(), "how many nights is the alfama booking", workflows, routedAs("event_from_email", { query: "alfama booking" }))).intent).toBe("trips");
    expect((await runCommand(world(), "when is my flight", workflows, routedAs("trips"))).intent).toBe("trips");
  });
  it("'what time do I need to be at the bike shop': the one event that shares 'bike'", async () => {
    const r = await runCommand(world(), "what time do I need to be at the bike shop", workflows, routedAs("trips"));
    expect(r.reply).toMatch(/08:15/);
  });
  it("a question the model took for a reply goes to the mail, never 'what would you like me to do'", async () => {
    const r = await runCommand(world(), "what should I bring on the hike", workflows, routedAs("draft_reply", { who: "Maria" }));
    expect(r.intent).toBe("email_question");
    expect(r.asked).toBeFalsy();
  });
  it("'has priya replied and if not nudge her': two asks, and 'her' is Priya", () => {
    expect(splitAsks("has priya replied and if not nudge her", ["Priya"])).toEqual(["has priya replied", "nudge Priya"]);
  });
});

import { looserQueries } from "@/server/agents/assistant";
describe("looser mail searches drop possessives", () => {
  it("'the landlord's boiler visit' -> 'landlord boiler visit', 'landlord boiler'…", () => {
    const q = looserQueries("the landlord's boiler visit");
    expect(q).toContain("landlord boiler");
    expect(q.join(" ")).not.toMatch(/'s/);
  });
});

describe("a note that shares one word with an event stays a note", () => {
  it("'how long is my spanish streak' (v1 no07) is not the Spanish exchange", async () => {
    const r = await runCommand(world(), "how long is my spanish streak", workflows, routedAs("notes_search", { query: "spanish streak" }));
    expect(r.intent).toBe("notes");
  });
});

import { agenda } from "@/server/agents/assistant";
// Failures of the held-out set v5 (run 2026-10-18 on c8), now tuning material: the general causes only.
describe("v5: second halves keep the first half's subject; words for hours; own events aren't looked up", () => {
  const k = ["Tom", "landlord", "Priya", "Maria"];
  it("'and if he hasn't chase him': two asks, 'him' is Tom", () => {
    expect(splitAsks("has tom answered and if he hasn't chase him", k)).toEqual(["has tom answered", "chase Tom"]);
  });
  it("'…and what does it include': 'it' is quote B", () => {
    expect(splitAsks("how much is quote B and what does it include", k)).toEqual(["how much is quote B", "what does quote B include"]);
  });
  it("'…and reply that tuesday is fine': the reply is to the landlord", () => {
    expect(splitAsks("what did the landlord say and reply that tuesday is fine", k)).toEqual(["what did the landlord say", "reply to landlord that tuesday is fine"]);
  });
  it("'at half past four' is 16:30", () => {
    const p = parseEventRequest("haircut next wednesday at half past four", new Date("2026-10-15T08:30:00Z"), "Europe/Madrid");
    expect("error" in p ? p.error : `${p.title} | ${madrid(p.startsAt)}`).toBe("Haircut | 2026-10-21 16:30");
  });
  it("'add the school concert on november 12 at 6:30pm' is the user's own event, not a web search", async () => {
    const r = await runCommand(world(), "add the school concert on november 12 at 6:30pm", workflows, routedAs("event_from_web", { query: "school concert" }));
    expect(r.intent).toBe("event");
    expect(r.event?.title).toMatch(/school concert/i);
  });
  it("'what's still to come today' leaves out what's over", async () => {
    const r = await agenda(world(), "what's still to come today");
    expect(r.items?.map((i) => i.title).join(" ") ?? r.reply).not.toMatch(/Dentist/);
  });
});

import { groundNumbers } from "@/server/agents/assistant";
describe("review of the day's rules (2026-10-18)", () => {
  it("the weather's 'it' is never replaced by the first half's subject", () => {
    expect(splitAsks("when is lunch and is it going to rain", [])?.[1]).toBe("is it going to rain");
  });
  it("hour words only where a time ends: 'at Seven Seas' stays a name", () => {
    const p = parseEventRequest("dinner at seven seas restaurant friday 8pm", new Date("2026-10-15T08:30:00Z"), "Europe/Madrid");
    expect("error" in p ? p.error : `${p.title} ${p.location ?? ""}`).toMatch(/seven seas/i);
  });
  it("the figure check never leaves a lead-in fragment as the answer", () => {
    expect(groundNumbers("On 12 March, the price rose to 334 EUR.", "the price on 12 March")).toBe("I couldn't confirm the details from the sources: they're listed below.");
  });
  it("trips keep itineraries and 'leave for <place>'", async () => {
    expect((await runCommand(world(), "what's my itinerary", workflows, routedAs("trips"))).intent).toBe("trips");
    expect((await runCommand(world(), "when do I leave for lisbon", workflows, routedAs("trips"))).intent).toBe("trips");
  });
});

import { calendarQuestion, calendarModelAnswer } from "@/server/agents/assistant";
import { wantsCalendarModel } from "@/server/agents/command";
import { setSetting } from "@/server/db";
describe("experiment: the model answers calendar questions the rules only listed (off by default)", () => {
  it("questions, not listings", () => {
    for (const q of ["do I have a gap this afternoon", "how many things do I have on tomorrow", "when does lunch end", "what's my first thing on friday"]) expect(calendarQuestion(q), q).toBe(true);
    for (const q of ["what's on tomorrow", "anything this weekend", "what do I have today", "show my calendar for next week"]) expect(calendarQuestion(q), q).toBe(false);
  });
  it("off: the list, as before; on: a background answer from the listed events, figures checked, the list kept", async () => {
    const ctx = world();
    const q = "how many things do I have on tomorrow";
    const off = await runCommand(ctx, q, workflows, routedAs("agenda"));
    expect(off.reply).toMatch(/^2 events tomorrow/);
    const listedNow = await agenda(ctx, q);
    expect(wantsCalendarModel(ctx, q, listedNow)).toBe(false);
    setSetting(ctx.db, "assistant.calendarModel", "on");
    expect(wantsCalendarModel(ctx, q, listedNow)).toBe(true);
    expect(wantsCalendarModel(ctx, "what's on tomorrow", listedNow)).toBe(false);
    const llm = stubLlm("Yes: you're free from 13:30 to 18:00.");
    const listed = { reply: "1 event today afternoon (Thursday 15 October):", items: [{ title: "12:30–13:30 Lunch with Sam", detail: "Café Lumen" }, { title: "18:00–19:30 Community garden committee" }] };
    const r = await calendarModelAnswer(ctx, "do I have a gap this afternoon", listed, () => {}, llm);
    expect(r.reply).toBe("Yes: you're free from 13:30 to 18:00.");
    expect(r.items).toHaveLength(2);
    expect(llm.calls[0].user).toMatch(/Lunch with Sam/);
    // An invented time is dropped; if nothing is left, the list's own line comes back.
    const bad = await calendarModelAnswer(ctx, "when does lunch end", listed, () => {}, stubLlm("Lunch ends at 14:45."));
    expect(bad.reply).toBe(listed.reply);
    // The model failing: the list.
    expect((await calendarModelAnswer(ctx, "when does lunch end", listed, () => {}, { id: "x", label: "x", generate: async () => { throw new Error("down"); } })).reply).toBe(listed.reply);
  });
});

describe("a reminder for later today on today's weekday is today's", () => {
  it("'remind me thursday night to pack my bag', said on Thursday morning: tonight 20:00", () => {
    const p = parseEventRequest("thursday night to pack my bag", new Date("2026-10-15T08:30:00Z"), "Europe/Madrid", 9 * 60);
    expect("error" in p ? p.error : madrid(p.startsAt)).toBe("2026-10-15 20:00");
    // An event keeps the earlier rule: today's weekday is next week's.
    const e = parseEventRequest("yoga thursday 7pm", new Date("2026-10-15T08:30:00Z"), "Europe/Madrid");
    expect("error" in e ? e.error : madrid(e.startsAt)).toBe("2026-10-22 19:00");
  });
});

describe("quarter past, quarter to", () => {
  it("'on the 26th at quarter past ten' is 10:15; 'quarter to four' is 15:45", () => {
    const now = new Date("2026-10-15T08:30:00Z");
    const at = (t: string) => { const p = parseEventRequest(t, now, "Europe/Madrid"); return "error" in p ? p.error : `${p.title} | ${madrid(p.startsAt)}`; };
    expect(at("meeting with the bank on the 26th at quarter past ten")).toBe("Meeting with the bank | 2026-10-26 10:15");
    expect(at("call friday at quarter to four")).toBe("Call | 2026-10-16 15:45");
  });
});
