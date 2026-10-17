import { describe, expect, it } from "vitest";
import { correctWeekdayDate, parseEventRequest } from "@/server/agents/eventParse";
import { splitAsks } from "@/server/agents/command";
import { quickRoute } from "@/server/agents/assistant";

const NOW = new Date("2026-10-15T10:00:00Z"); // a Thursday
const TZ = "Europe/Madrid";

describe("weekday named in an email beats the model's date", () => {
  const mail = "Subject: Boiler inspection next Tuesday\nThe engineer can come between 9 and 12 next Tuesday.";
  it("corrects a Sunday to the Tuesday after the send date", () => {
    expect(correctWeekdayDate("2026-10-18", mail, "2026-10-15")).toBe("2026-10-20");
  });
  it("keeps a date that already matches, an explicit far-off date, and mails naming two weekdays", () => {
    expect(correctWeekdayDate("2026-10-20", mail, "2026-10-15")).toBe("2026-10-20");
    expect(correctWeekdayDate("2026-12-04", "Concert on Saturday 4 December", "2026-10-15")).toBe("2026-12-04");
    expect(correctWeekdayDate("2026-10-18", "Tuesday or Wednesday works", "2026-10-15")).toBe("2026-10-18");
    expect(correctWeekdayDate("soon", mail, "2026-10-15")).toBe("soon");
  });
});

describe("reminder dates and times", () => {
  it("a part of the day gives a time, and the weekday keeps its date", () => {
    const e = parseEventRequest("bring the map on friday evening", NOW, TZ, 9 * 60);
    expect("error" in e).toBe(false);
    if (!("error" in e)) {
      expect(e.startsAt).toBe("2026-10-16T16:00:00.000Z"); // 18:00 in Madrid (UTC+2)
      expect(e.title).toBe("Bring the map");
    }
  });
  it("'in three weeks' counts, and a date alone is due at 09:00, not midnight", () => {
    const w = parseEventRequest("renew my passport in three weeks", NOW, TZ, 9 * 60);
    expect("error" in w ? "" : w.startsAt).toBe("2026-11-05T08:00:00.000Z"); // 09:00 in Madrid (UTC+1 after the clocks change)
    const t = parseEventRequest("call mom tomorrow", NOW, TZ, 9 * 60);
    expect("error" in t ? "" : t.startsAt).toBe("2026-10-16T07:00:00.000Z");
    const m = parseEventRequest("pay rent in a month", NOW, TZ, 9 * 60);
    expect("error" in m ? "" : m.startsAt.slice(0, 10)).toBe("2026-11-15");
  });
});

describe("more two-asks-in-one and quick rules", () => {
  it("splits before a follow-up question", () => {
    expect(splitAsks("what's in my notes about the kitchen and has Priya answered")?.[1]).toBe("has Priya answered");
  });
  it("'find a free hour … and email Marc to propose it' offers 60-minute slots to Marc", () => {
    expect(quickRoute("find a free hour on thursday and email Marc to propose it")).toEqual({ skill: "propose_times", args: { who: "Marc", minutes: 60 } });
  });
});

describe("a second half that depends on the first is not split", () => {
  it("keeps 'the weather there' and 'prepare for any of it' with their first half", () => {
    expect(splitAsks("what's my next flight and what will the weather be like there")).toBeNull();
    expect(splitAsks("do I have anything coming up this week, and do I need to prepare for any of it?")).toBeNull();
  });
});

import { correctRoute } from "@/server/agents/command";
import { skippedNote } from "@/server/agents/assistant";
import { weekdayAfter } from "@/server/agents/eventParse";

describe("round 2 fixes", () => {
  it("a due date in words is checked against the weekday too, and kept as written when it is fine", () => {
    const mail = "Boiler inspection next Tuesday";
    expect(correctWeekdayDate("18 October", mail, "2026-10-15", NOW, TZ)).toBe("2026-10-20");
    expect(correctWeekdayDate("20 October", mail, "2026-10-15", NOW, TZ)).toBe("20 October");
    expect(correctWeekdayDate("by the end of the week", mail, "2026-10-15", NOW, TZ)).toBe("by the end of the week");
  });
  it("'next Tuesday' in a mail sent on a Thursday is the following Tuesday", () => {
    expect(weekdayAfter("The engineer comes next Tuesday", "2026-10-15")).toBe("2026-10-20");
    expect(weekdayAfter("Tuesday or Wednesday", "2026-10-15")).toBeNull();
  });
  it("'check my mail for X and set a reminder before it renews' is one chain; the day before comes from the mail", () => {
    expect(correctRoute("check my mail for my car insurance and set a reminder two weeks before it renews", { skill: "email_search", args: { query: "car insurance" } }).skill).toBe("reminder_from_email");
    const r = correctRoute("remind me about the boiler inspection the day before", { skill: "reminder", args: {} });
    expect(r.skill).toBe("reminder_from_email");
    expect(r.args.query).toBe("boiler inspection");
    expect(correctRoute("remind me to call mom the day before tomorrow", { skill: "reminder", args: {} }).skill).toBe("reminder");
  });
  it("splitting rules: not before a reminder that points back at a mail search; a reminder with 'it' says what it is", () => {
    expect(splitAsks("check my mail for my car insurance and set a reminder two weeks before it renews")).toBeNull();
    expect(splitAsks("email Jordan my vote for the book club and remind me to read it")?.[1]).toBe("remind me to read it (about the book club)");
    expect(splitAsks("tell me about the half marathon plan and whether the long run on the weekend fits")?.[1]).toBe("whether the long run on the weekend fits");
  });
  it("'whether it fits on the weekend' asks the calendar", () => {
    expect(quickRoute("whether the long run on the weekend fits")?.skill).toBe("agenda");
  });
  it("says what was left out instead of claiming nothing exists", () => {
    expect(skippedNote({ skipped: { bulk: 0, flagged: 1 } })).toContain("instructions aimed at an AI");
    expect(skippedNote({ skipped: { bulk: 2, flagged: 0 } })).toContain("2 newsletters or promotions were left out");
    expect(skippedNote({ skipped: { bulk: 0, flagged: 0 } })).toBe("");
  });
});

describe("'next <weekday>' means the following week", () => {
  it("is the next calendar week's day, whichever day the mail was sent", () => {
    expect(weekdayAfter("next Tuesday", "2026-10-12")).toBe("2026-10-20"); // sent on a Monday
    expect(weekdayAfter("next Tuesday", "2026-10-15")).toBe("2026-10-20"); // sent on a Thursday
    expect(weekdayAfter("next Monday", "2026-10-18")).toBe("2026-10-19"); // sent on a Sunday
    expect(weekdayAfter("on Tuesday", "2026-10-12")).toBe("2026-10-13"); // a bare weekday: the first one after
  });
  it("fixes the right weekday in the wrong week", () => {
    expect(correctWeekdayDate("2026-10-13", "next Tuesday", "2026-10-12")).toBe("2026-10-20");
    expect(correctWeekdayDate("2026-10-20", "next Tuesday", "2026-10-12")).toBe("2026-10-20");
  });
});

import { vi } from "vitest";
import { replyContent } from "@/server/agents/command";
import { reminderFromText } from "@/server/agents/assistant";
import { reloadConfig } from "@/server/config";
import { seededCtx } from "./helpers";

describe("batch 5 fixes", () => {
  it("takes what a reply should say out of the request", () => {
    expect(replyContent("can u tell the landlord thursday is fine for the boiler", "landlord")).toBe("thursday is fine for the boiler");
    expect(replyContent("reply to Ana that Thursday works for me", "Ana")).toBe("Thursday works for me");
    expect(replyContent("tell Laura yes for dinner on Saturday", "Laura")).toBe("yes for dinner on Saturday");
    expect(replyContent("answer Julien", "Julien")).toBe("answer Julien");
  });
  it("two reminders in one request, and 'she' is the person named in the first half", () => {
    expect(splitAsks("put a reminder on friday at 5pm to water the plants and another on saturday morning to buy bread")).toEqual([
      "put a reminder on friday at 5pm to water the plants",
      "remind me on saturday morning to buy bread",
    ]);
    expect(splitAsks("when did Maria write and what did she ask")).toEqual(["when did Maria write", "what did Maria ask"]);
    expect(splitAsks("find any mail about my race registration and add the date to my calendar")).toBeNull();
  });
  it("routing nets: a period question is the calendar, travel words are needed for trips, a question is not a reminder", () => {
    expect(correctRoute("list what I have to do this weekend", { skill: "priorities", args: {} }).skill).toBe("agenda");
    expect(correctRoute("what should I do first", { skill: "priorities", args: {} }).skill).toBe("priorities");
    expect(correctRoute("is there a spanish thing coming up", { skill: "trips", args: {} }).skill).toBe("agenda");
    expect(correctRoute("my next flight", { skill: "trips", args: {} }).skill).toBe("trips");
    const q = correctRoute("do i have to pay anything soon", { skill: "reminder", args: {} });
    expect(q.skill).toBe("email_question");
    expect(q.args.query).toContain("renewal");
    expect(correctRoute("remind me to pay rent", { skill: "reminder", args: {} }).skill).toBe("reminder");
  });
  it("headlines go to the web", () => {
    expect(quickRoute("tell me the headlines")?.skill).toBe("web_search");
    expect(quickRoute("tell me the headlines and what the weather's like")).toBeNull();
  });
  it("reminder wording and dates: 'on the 1st', 'reminder:', 'put a reminder', no stray 'to'", () => {
    vi.stubEnv("ACC_TIMEZONE", "Europe/Madrid");
    reloadConfig();
    try {
      const ctx = seededCtx(); // Monday 12 Oct 2026
      expect(reminderFromText(ctx, "reminder: pay rent on the 1st").reply).toBe("Added to your reminders: “Pay rent”, due Sun 1 Nov at 09:00.");
      expect(reminderFromText(ctx, "put a reminder on friday at 5pm to water the plants").reply).toBe("Added to your reminders: “Water the plants”, due Fri 16 Oct at 17:00.");
      expect(reminderFromText(ctx, "remind me tmrw morning to call Priya").reply).toBe("Added to your reminders: “Call Priya”, due Tue 13 Oct at 09:00.");
    } finally {
      vi.unstubAllEnvs();
      reloadConfig();
    }
  });
});

describe("parser phrasings found by the phrasing table", () => {
  const at = (text: string) => {
    const r = parseEventRequest(text, NOW, TZ, 9 * 60);
    return "error" in r ? `ERR ${r.error.slice(0, 12)}` : `${r.startsAt.slice(0, 16)}Z ${r.title}`;
  };
  it("tonight and evening hours are PM", () => {
    expect(at("call mom tonight")).toBe("2026-10-15T18:00Z Call mom"); // 20:00 in Madrid (UTC+2)
    expect(at("call mom tonight at 8")).toBe("2026-10-15T18:00Z Call mom");
    expect(at("call mom this evening")).toBe("2026-10-15T16:00Z Call mom");
  });
  it("relative moments and loose periods for reminders", () => {
    expect(at("buy milk in 2 hours")).toBe("2026-10-15T12:00Z Buy milk");
    expect(at("buy milk in 30 minutes")).toBe("2026-10-15T10:30Z Buy milk");
    expect(at("buy milk next week")).toBe("2026-10-19T07:00Z Buy milk"); // the Monday, 09:00
    expect(at("buy milk this weekend")).toBe("2026-10-17T07:00Z Buy milk");
    expect(at("buy milk end of the month")).toBe("2026-10-31T08:00Z Buy milk"); // 09:00 in Madrid after the clocks go back
  });
  it("half past, midday, and no dangling 'by'", () => {
    expect(at("meeting at half past 10")).toBe("2026-10-16T08:30Z Meeting");
    expect(at("lunch at midday")).toBe("2026-10-16T10:00Z Lunch");
    expect(at("submit report by friday")).toBe("2026-10-16T07:00Z Submit report");
  });
});

describe("splitter table findings", () => {
  it("a second half that says what to report about a search is one request", () => {
    expect(splitAsks("check my emails and tell me what's urgent")).toBeNull();
    expect(splitAsks("check my mail for the invoice and tell me the amount")).toBeNull();
    expect(splitAsks("what's on tomorrow and remind me to bring cash")).not.toBeNull();
  });
  it("'I'm' is not a name, so 'him' is Sam", () => {
    expect(splitAsks("email Sam that I'm late and add a reminder to call him")?.[1]).toBe("add a reminder to call Sam");
  });
  it("'chase the oldest one' is the longest wait", () => {
    expect(quickRoute("chase the oldest one")).toEqual({ skill: "nudge", args: { who: "longest" } });
  });
});

describe("review pass fixes", () => {
  it("a short name is matched as a whole word", () => {
    expect(replyContent("tell Al that it's really fine", "Al")).toBe("it's really fine");
    expect(replyContent("really tell Al yes please", "Al")).toBe("yes please");
  });
  it("trips are kept for travel questions without a listed travel word", () => {
    expect(correctRoute("when do I leave for Lisbon", { skill: "trips", args: {} }).skill).toBe("trips");
    expect(correctRoute("is there a spanish thing coming up", { skill: "trips", args: {} }).skill).toBe("agenda");
  });
});

import { parseDraft } from "@/server/agents/chiefOfStaff";
describe("draft parsing tolerates Markdown labels and a missing REPLY label", () => {
  it("reads the 8B's real output shapes", () => {
    expect(parseDraft("**SUMMARY:** Confirming Thursday for the boiler inspection.\n\n---\nThursday is fine for the boiler. Thank you!")).toEqual({ summary: "Confirming Thursday for the boiler inspection.", reply: "Thursday is fine for the boiler. Thank you!" });
    expect(parseDraft("SUMMARY: Asks about the hike.\n\nHi Maria,\n\nYes, count me in!")?.reply).toBe("Hi Maria,\n\nYes, count me in!");
    expect(parseDraft("SUMMARY: x\nREPLY:\nHi Ana,\n\nThursday works for me.")?.reply).toBe("Hi Ana,\n\nThursday works for me.");
    expect(parseDraft("no labels at all")).toBeNull();
  });
});

import { contactLookup } from "@/server/agents/assistant";
describe("batch 5 second-pass fixes", () => {
  it("routes contact, weather and 'is there a X coming up' phrasings", () => {
    expect(quickRoute("what's priya's email")).toEqual({ skill: "contact_lookup", args: { who: "priya" } });
    expect(quickRoute("what the weather's like")?.skill).toBe("weather");
  });
  it("finds an address from the user's own mail, and says so when there is none", () => {
    const ctx = seededCtx();
    expect(contactLookup(ctx, "priya").reply).toMatch(/priya@example\.com/);
    expect(contactLookup(ctx, "zebedee").reply).toMatch(/don't have an email address/);
  });
});

import { agenda, nudge } from "@/server/agents/assistant";
describe("no duplicate follow-up, and the next event by keyword", () => {
  it("a second 'chase Priya' points to the follow-up already waiting", async () => {
    const ctx = seededCtx();
    const first = await nudge(ctx, "Priya");
    const second = await nudge(ctx, "Priya");
    expect(first.reply).toMatch(/Drafted a follow-up/); // the seeded fixture allows demo follow-ups
    if (/Drafted a follow-up/.test(first.reply)) {
      expect(second.reply).toMatch(/already waiting for your approval/);
      expect(second.actionId).toBe(first.actionId);
    } else {
      expect(first.reply).toBe(second.reply); // no permission in this fixture: same refusal both times, nothing drafted
    }
  });
  it("'is there a spanish thing coming up' finds the Spanish exchange", async () => {
    const ctx = seededCtx();
    expect((await agenda(ctx, "is there a spanish thing coming up")).reply).toMatch(/Spanish conversation exchange/);
  });
});

import { looserQuery, looserQueries } from "@/server/agents/assistant";
describe("batch 6 first-pass fixes", () => {
  it("routing nets: 'when is X coming', a clock time is an event, a general question goes to the web, 'what should I reply to X'", () => {
    expect(correctRoute("when's the boiler guy coming", { skill: "waiting_on", args: {} }).skill).toBe("email_question");
    expect(correctRoute("schedule a call with Jordan friday 4pm", { skill: "propose_times", args: { who: "Jordan" } }).skill).toBe("add_event");
    expect(correctRoute("send Ana a few times that work", { skill: "propose_times", args: { who: "Ana" } }).skill).toBe("propose_times");
    expect(correctRoute("what's the capital of australia", { skill: "unsupported", args: {} }).skill).toBe("web_search");
    expect(correctRoute("what's my favourite colour", { skill: "unsupported", args: {} }).skill).toBe("unsupported");
    expect(correctRoute("what should I reply to the landlord", { skill: "followups", args: {} })).toEqual({ skill: "draft_reply", args: { who: "landlord" } });
    expect(replyContent("what should I reply to the landlord", "landlord")).toBe("");
  });
  it("a search with question words is retried with its main words", () => {
    expect(looserQuery("car insurance renewal cost AND date")).toBe("car insurance renewal");
    expect(looserQuery("from:Priya")).toBeNull();
  });
  it("'..., can you remind me friday night' puts the task first and the time at 20:00", () => {
    vi.stubEnv("ACC_TIMEZONE", "Europe/Madrid");
    reloadConfig();
    try {
      const ctx = seededCtx(); // Monday 12 Oct 2026
      expect(reminderFromText(ctx, "i need to bring the map on saturday, can you remind me friday night").reply).toBe("Added to your reminders: “Bring the map on saturday”, due Fri 16 Oct at 20:00.");
    } finally {
      vi.unstubAllEnvs();
      reloadConfig();
    }
  });
});

describe("'night' as a time only after a day", () => {
  it("friday night is 20:00, a night shift keeps its title and hours", () => {
    const fri = parseEventRequest("bring the map friday night", NOW, TZ, 9 * 60);
    expect("error" in fri ? "" : fri.startsAt).toBe("2026-10-16T18:00:00.000Z");
    const shift = parseEventRequest("night shift sunday 1am-4am", NOW, TZ);
    expect("error" in shift ? "" : `${shift.title} ${shift.start}`).toBe("Night shift 2026-10-18T01:00");
  });
});

describe("batch 6 second-pass fixes", () => {
  it("looser searches drop slang and alternatives, then fall back to one word", () => {
    expect(looserQueries("boiler guy")).toEqual(["boiler"]);
    expect(looserQueries("car insurance renewal cost OR renewal amount OR premium due")).toEqual(["car insurance renewal", "car insurance", "car", "insurance"]);
    expect(looserQueries("from:Priya")).toEqual([]);
  });
  it("a how-much / when question about mail reads the mail", () => {
    expect(correctRoute("how much does my car insurance renewal cost and when", { skill: "email_search", args: { query: "car insurance" } }).skill).toBe("email_question");
    expect(correctRoute("find the invoice from Endesa", { skill: "email_search", args: { query: "from:Endesa invoice" } }).skill).toBe("email_search");
  });
});

import { parseRange } from "@/server/agents/when";
describe("batch 7 fixes (parsing and routing)", () => {
  it("'tomorrow' after 'remind me' is not cut, 'every' does not dangle, and a single reminder says so", () => {
    vi.stubEnv("ACC_TIMEZONE", "Europe/Madrid");
    reloadConfig();
    try {
      const ctx = seededCtx(); // Monday 12 Oct 2026
      expect(reminderFromText(ctx, "remind me tomorrow evening to pack for the hike").reply).toBe("Added to your reminders: “Pack for the hike”, due Tue 13 Oct at 18:00.");
      expect(reminderFromText(ctx, "remind me to water the plants every sunday").reply).toMatch(/^Added to your reminders: “Water the plants”, due Sun 18 Oct at 09:00\. Reminders don't repeat/);
    } finally {
      vi.unstubAllEnvs();
      reloadConfig();
    }
  });
  it("'the 20th' is a day", () => {
    expect(parseRange("am I busy on the 20th", NOW, TZ).label).toMatch(/20 October/);
    expect(parseRange("am I busy on the 3rd", NOW, TZ).label).toMatch(/3 November/);
  });
  it("splitting: 'let maria know' after a reminder, and a lowercase name for 'her'", () => {
    expect(splitAsks("remind me tomorrow evening to pack for the hike and let maria know I'm bringing the map")?.[1]).toBe("let maria know I'm bringing the map");
    expect(splitAsks("chase priya about the quote and remind me to call her friday")?.[1]).toBe("remind me to call Priya friday");
  });
  it("routing nets for batch 7's misroutes", () => {
    expect(correctRoute("who's coming to the committee tonight", { skill: "waiting_on", args: {} }).skill).toBe("agenda");
    expect(correctRoute("who did I last hear from", { skill: "waiting_on", args: {} })).toEqual({ skill: "email_search", args: { query: "in:inbox", days: 7 } });
    expect(correctRoute("who hasn't answered me", { skill: "waiting_on", args: {} }).skill).toBe("waiting_on");
    expect(correctRoute("what time is lunch with Sam and where", { skill: "event_from_email", args: {} }).skill).toBe("agenda");
    expect(correctRoute("how many km is my long run on sunday", { skill: "notes_search", args: {} }).skill).toBe("agenda");
    expect(correctRoute("what did I note for sunday", { skill: "notes_search", args: {} }).skill).toBe("notes_search");
    expect(correctRoute("what do I owe on the car insurance", { skill: "notes_search", args: {} }).skill).toBe("email_question");
  });
});

import { groundNumbers, plainAnswer } from "@/server/agents/assistant";
describe("figures in answers must be in the sources", () => {
  const mail = "Subject: Your car insurance renews on 1 December 2026. Your car insurance policy renews on 1 December 2026. The renewal price is 412 EUR.";
  it("drops an invented figure and says so", () => {
    expect(groundNumbers("The premium goes up by 78 EUR from 334 EUR to 412 EUR [1].", mail)).toBe("I couldn't confirm the details from the sources: they're listed below.");
    // A sentence with an unknown figure next to a bare citation: never an answer that is only "[1]".
    expect(groundNumbers("Maria asks if you can bring 13 maps. [1]", "Bring the map, leaving at 8am")).toBe("I couldn't confirm the details from the sources: they're listed below.");
    expect(groundNumbers("The renewal costs 412 EUR [1]. It was 334 EUR last year.", mail)).toBe("The renewal costs 412 EUR [1]. (I left out a figure I couldn't find in the sources.)");
  });
  it("keeps grounded figures, reformatted ones, dates and citations", () => {
    expect(groundNumbers("Quote B is €7,600 and the cap is €8 000 [1][2].", "Quote B: €7600. Ceiling €8,000.")).toBe("Quote B is €7,600 and the cap is €8 000 [1][2].");
    expect(groundNumbers("The engineer comes next Tuesday (October 20, 2026) between 9 and 12.", "2026-10-15 between 9 and 12 next Tuesday")).toBe("The engineer comes next Tuesday (October 20, 2026) between 9 and 12.");
  });
  it("internal data tags never reach the user", () => {
    expect(plainAnswer("Amount: <untrusted>334 EUR</untrusted> due.")).toBe("Amount: 334 EUR due.");
  });
});

import { retrieve } from "@/server/retrieval/knowledge";
import { stem } from "@/server/retrieval/text";
describe("notes search matches word forms", () => {
  it("stems running/runs/planned and finds the training note for 'my running goal'", async () => {
    expect([stem("running"), stem("runs"), stem("planned"), stem("quotes"), stem("glass")]).toEqual(["run", "run", "plan", "quote", "glass"]);
    const res = await retrieve(seededCtx(), { query: "what's my running goal", provider: "lexical", k: 2 }, undefined, "chief_of_staff");
    expect(res.passages[0]?.title).toMatch(/Half-marathon/);
  });
});
