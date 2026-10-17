import { describe, expect, it } from "vitest";
import { correctRoute, splitAsks, runCommand } from "@/server/agents/command";
import { quickRoute, searchWords, looserQueries } from "@/server/agents/assistant";
import { workflows } from "@/server/agents/chiefOfStaff";
import type { LlmProvider } from "@/server/llm";
import { seededCtx } from "./helpers";

/** Fixes from the baseline run of evaluation set v1 (dev split), 2026-10-16. */
describe("baseline v1 fixes", () => {
  it("a calendar entry with a person in it is an event, not a reply to them", () => {
    expect(correctRoute("add dinner with Laura saturday 8pm at Casa Pepe", { skill: "draft_reply", args: { who: "Laura" } }).skill).toBe("add_event");
    expect(correctRoute("add lunch with Priya on the 23rd at 1pm", { skill: "draft_reply", args: { who: "Priya" } }).skill).toBe("add_event");
    // ...but a reply that also adds stays a reply
    expect(correctRoute("tell Laura yes and add the dinner saturday to my calendar", { skill: "reply_and_add", args: { who: "Laura" } }).skill).toBe("reply_and_add");
  });

  it("what's left today is the calendar; the kitchen budget is in the notes, not the subscriptions", () => {
    expect(correctRoute("whats left today", { skill: "priorities", args: {} }).skill).toBe("agenda");
    expect(correctRoute("what's the kitchen budget", { skill: "subscriptions", args: {} })).toEqual({ skill: "notes_search", args: { query: "kitchen budget" } });
    expect(correctRoute("what am I paying for every month", { skill: "subscriptions", args: {} }).skill).toBe("subscriptions");
  });

  it("what time is my dentist is the calendar's next matching event, but flights stay trips", () => {
    expect(quickRoute("what time is my dentist")?.skill).toBe("agenda");
    expect(quickRoute("when is my next yoga class")?.skill).toBe("agenda");
    expect(quickRoute("what time is my flight")).toBeNull();
  });

  it("mail is searched with the request's subject words, not the whole sentence", () => {
    expect(searchWords("what's in the book club email")).toBe("book club");
    expect(searchWords("find the insurance email and tell me what it costs")).toBe("insurance");
    expect(looserQueries("the hike with maria")).toEqual(["hike maria", "hike", "maria"]);
  });

  it("a second question about the same thing is one request", () => {
    expect(splitAsks("what time is the committee and where is it")).toBeNull();
  });

  it("a question is never turned into an action by the self-check", async () => {
    const ctx = seededCtx();
    const route: LlmProvider = { id: "r", label: "r", generate: async () => ({ text: '{"skill":"agenda","args":{}}', model: "r", ms: 1 }) };
    const checker: LlmProvider = { id: "c", label: "c", generate: async () => ({ text: '{"ok":false,"missing":"x","skill":"deadlines_to_reminders"}', model: "c", ms: 1 }) };
    const r = await runCommand(ctx, "is the afternoon looking busy", workflows, route, checker);
    expect(r.intent).toBe("agenda");
  });

  it("a reply whose person the model left out takes them from the wording", async () => {
    const ctx = seededCtx();
    const route: LlmProvider = { id: "r", label: "r", generate: async () => ({ text: '{"skill":"draft_reply","args":{}}', model: "r", ms: 1 }) };
    const r = await runCommand(ctx, "tell the landlord tuesday morning works", workflows, route);
    expect(r.asked).toBeFalsy();
    expect(r.reply).toMatch(/Writing a reply to landlord/);
  });

  it("bills coming up are read from the mail, not the calendar", () => {
    expect(correctRoute("what bills do I have coming up", { skill: "agenda", args: {} }).skill).toBe("email_question");
    expect(correctRoute("any meetings coming up", { skill: "agenda", args: {} }).skill).toBe("agenda");
  });

  it("v1 held-out kinds: personal questions to the notes, events with a time added, plans on a day in the calendar", () => {
    expect(correctRoute("what grammar am I working on in spanish", { skill: "web_search", args: {} }).skill).toBe("notes_search");
    expect(correctRoute("who won the match last night", { skill: "web_search", args: {} }).skill).toBe("web_search");
    expect(correctRoute("when is the paris marathon? add it to my calendar", { skill: "web_search", args: {} }).skill).toBe("web_search");
    expect(correctRoute("add the book club for next friday at 7pm", { skill: "event_from_email", args: {} }).skill).toBe("add_event");
    expect(correctRoute("do I have plans on saturday", { skill: "waiting_on", args: {} }).skill).toBe("agenda");
  });

  it("the second half keeps its subject: a reply to the person, a reminder about the thing", () => {
    expect(splitAsks("summarize the Maria email and draft a yes", ["Maria"])).toEqual(["summarize the Maria email", "reply to Maria: yes"]);
    expect(splitAsks("how much is the insurance and remind me 2 weeks before it renews")).toEqual(["how much is the insurance", "remind me 2 weeks before the insurance renews"]);
  });

  it("a rundown of a day is that day's calendar, not the morning briefing", () => {
    expect(correctRoute("give me a quick rundown of tomorrow", { skill: "prep_day", args: {} }).skill).toBe("agenda");
    expect(correctRoute("prep me for tomorrow's meetings", { skill: "prep_day", args: {} }).skill).toBe("prep_day");
  });

  it("'add … at 10' is an event; a request starting 'remind me' is a reminder (the self-check used to rescue these)", () => {
    expect(correctRoute("add dentist follow-up in two weeks at 10", { skill: "reminder", args: {} }).skill).toBe("add_event");
    expect(correctRoute("add a reminder for monday to send the invoice", { skill: "reminder", args: {} }).skill).toBe("reminder");
    expect(correctRoute("remind me the day before my flight to check in", { skill: "event_from_email", args: {} }).skill).toBe("reminder");
    expect(correctRoute("find the concert in my email and add it to my calendar", { skill: "event_from_email", args: {} }).skill).toBe("event_from_email");
  });
});
