import { z } from "zod";
import { all, getSetting, one, type Ctx } from "../db";
import { config } from "../config";
import { logActivity } from "../activity";
import { demoRowsFilter, serviceHidden } from "../mode";
import { callTool, type EventRow } from "../tools/registry";
import { RunBudget } from "../tools/budget";
import { draftLlmFor, fenceUntrusted, localLlm, selectedModel, UNTRUSTED_DATA_RULES, type LlmProvider } from "../llm";
import { aboutMePrompt } from "../memory";
import { detectLanguage } from "../lang";
import { injectionFlags, isAiDirected } from "../retrieval/text";
import { knowledgeStats, retrieve } from "../retrieval/knowledge";
import { nanoModelInstalled } from "../retrieval/embeddings";
import { check } from "../policy/engine";
import { addReminder } from "../reminders";
import { InsightError, proposeNudge } from "../insights";
import { eventOn, localToday, parseEventRequest, type PreparedEvent } from "./eventParse";
import type { WebResult } from "../connectors/websearch";
import { parseRange } from "./when";
import { parseSender, writeReply } from "./chiefOfStaff";
import { upcomingFlights } from "./flights";

/**
 * "Instinct": the Chief of Staff understands a request in plain English and does it. The local model
 * reads the request (the user's own words, never email content) and picks ONE skill from a fixed list;
 * every skill is ordinary code that goes through the same permission checks as the agents. The model
 * can't invent a skill, can't send, approve or change access, and dates are read by code, not by it.
 */

export const SKILLS = {
  inbox_review: "Read recent emails and tell what needs the user's action or attention: replies owed, requests, deadlines, bills to pay, things to sign or confirm, anything urgent or missed. Args: days (how far back; default 7).",
  email_search: "List or find specific emails, or check whether someone replied or wrote: from a person, about a topic, from a company, in spam, old promotions. Args: query (Gmail search: from:name, subject words, topic words, in:spam, category:promotions), days.",
  email_question: "Answer a question whose answer is written INSIDE the user's emails: a booking reference, a check-in time, an amount, an address, what someone said or decided. Args: query (Gmail search words to find those emails).",
  meeting_prep: "Prepare the user for an upcoming meeting or event: when it is, recent emails with that person or about it, and related notes. Args: who (the person or the meeting).",
  weather: "Weather forecast for the user's city or a named place, up to 7 days ahead. Args: query (the place, only if one is named).",
  agenda: "Questions about the user's calendar, schedule, events, meetings or free time on a day or period (today, tomorrow, this weekend, next week, a date).",
  add_event: "Add ONE new event to the user's calendar: an appointment, meeting, call, class, or a block of time reserved for something ('schedule a call…', 'block friday morning for…', 'put … in my calendar').",
  add_flights: "Add the flights or trips found in booking emails to the calendar.",
  event_from_email: "Find an event the user registered for, booked, bought tickets for or was invited to in their emails (a race, concert, appointment, course, reservation, match) and add it to the calendar. Args: query (Gmail search words for those emails).",
  reminder: "Remind the USER THEMSELVES to do something later (a to-do for the user), possibly at a time. Not a message to someone else.",
  reminder_from_email: "Find a bill, renewal or deadline in the user's emails and set a reminder before it's due. Args: query (Gmail search words for that email).",
  deadlines_to_reminders: "Go through recent emails and turn every deadline or action needed into reminders. Args: days.",
  trip_weather: "The weather forecast for the user's next trip (destination and dates from their booking emails).",
  prep_day: "Prepare the user for ALL the meetings of a day (one brief each): 'prep me for tomorrow's meetings'.",
  nudge_all: "Follow up with EVERYONE who hasn't answered the user (one polite follow-up draft each).",
  event_from_web: "Look up a public event on the web (a marathon, a festival, a match, a concert date) and add it to the calendar. Args: query.",
  reply_and_add: "Reply to someone's email (accepting an invitation, confirming) AND add that event to the calendar. Args: who, message.",
  draft_reply: "Write an email reply to someone for the user to approve. Args: who (the person), message (what the user wants to say).",
  nudge: "Follow up with, chase, or send a reminder TO SOMEONE ELSE who has not answered the user's email. Args: who.",
  waiting_on: "List the people who have not replied to the user's emails (threads where the user is waiting).",
  trips: "List upcoming trips, flights, hotels, train and car bookings found in email.",
  subscriptions: "Newsletters and paid subscriptions found in email: what the user pays for regularly, what they could cancel or unsubscribe from.",
  notes_search: "Answer a question from the user's own notes and documents (not email, not calendar). Args: query.",
  briefing: "Run the daily or morning briefing.",
  weekly_review: "Run the weekly review / summary of the week.",
  followups: "Draft replies to all the emails that are waiting for the user's answer.",
  pending_approvals: "What is waiting for the user's approval in this app (drafts, events, actions to review).",
  schedules: "The app's scheduled automatic tasks (when the briefing runs, etc.).",
  remember: "Save a NEW fact or preference the user states and asks you to remember. Never for questions. Args: fact.",
  propose_times: "Send someone a choice of free time slots by email, so THEY can pick one (no fixed time given). Args: who, minutes.",
  web_search: "Look something up on the internet (news, facts, prices, sports results, opening hours). Not weather. Args: query.",
  unsupported: "Anything else this app cannot do. Args: reason.",
} as const;
export type Skill = keyof typeof SKILLS;
const SKILL_NAMES = Object.keys(SKILLS) as [Skill, ...Skill[]];

export const RouteSchema = z.object({
  skill: z.enum(SKILL_NAMES),
  args: z
    .object({
      days: z.number().int().optional(),
      query: z.string().max(300).optional(),
      who: z.string().max(120).optional(),
      message: z.string().max(1000).optional(),
      fact: z.string().max(300).optional(),
      minutes: z.number().int().optional(),
      reason: z.string().max(300).optional(),
    })
    .partial()
    .default({}),
});
export type Route = z.infer<typeof RouteSchema>;

const ROUTE_JSON_SCHEMA = {
  type: "object",
  properties: {
    skill: { type: "string", enum: SKILL_NAMES },
    args: {
      type: "object",
      properties: { days: { type: "integer" }, query: { type: "string" }, who: { type: "string" }, message: { type: "string" }, fact: { type: "string" }, minutes: { type: "integer" }, reason: { type: "string" } },
    },
  },
  required: ["skill", "args"],
};

// One short line per skill: the whole prompt is read by a laptop CPU before every first request.
const PROMPT_SKILLS: Record<Skill, string> = {
  inbox_review: "what in recent email needs the user: replies owed, bills, documents to sign, deadlines, urgent, spam {days}",
  email_search: "list or find emails from someone / about something {query: Gmail search, days}",
  email_question: "answer from INSIDE emails received: did X reply, what X said, a reference, time, amount {query}",
  meeting_prep: "brief before a meeting or event {who}",
  agenda: "calendar questions: what's on, free or busy, how busy, when is my next X",
  add_event: "add one event, call, class or time block to the calendar",
  add_flights: "add the flights from booking emails to the calendar",
  event_from_email: "find an event in the user's emails (race, concert, appointment, reservation) and add it to the calendar {query}",
  reminder: "a to-do for the user: remind me, don't let me forget, add a task",
  reminder_from_email: "find a bill / renewal / deadline in the user's emails and remind them before it's due {query}",
  deadlines_to_reminders: "turn the deadlines and actions in recent emails into reminders {days}",
  trip_weather: "weather for the user's next trip (from their bookings)",
  prep_day: "briefs for ALL the meetings of a day",
  nudge_all: "follow up with EVERYONE who hasn't answered",
  event_from_web: "look up a public event's date on the web and add it to the calendar {query}",
  reply_and_add: "reply to someone (accept, confirm) AND add the event to the calendar {who, message}",
  draft_reply: "write a reply to someone {who, message}",
  nudge: "chase / follow up with / remind SOMEONE ELSE who hasn't answered {who}",
  waiting_on: "who hasn't answered the user",
  trips: "upcoming trips, flights, hotels, bookings",
  subscriptions: "newsletters, subscriptions, what the user pays for regularly",
  notes_search: "anything the user wrote down in notes: goals, plans, lists, ideas, how-tos {query}",
  briefing: "the daily / morning briefing",
  weekly_review: "the weekly review",
  followups: "draft replies to all emails waiting for the user",
  pending_approvals: "what waits for the user's approval in the app",
  schedules: "when the app's automatic tasks (briefing, weekly review) run",
  remember: "save a fact about the user ONLY when they say 'remember …' {fact}",
  propose_times: "email someone free slots so THEY pick {who, minutes}",
  weather: "weather forecast {query: place}",
  web_search: "news, facts, sports, prices: needs the internet {query}",
  unsupported: "anything else: translating, booking, buying, music, smart home {reason}",
};

// Worked examples: small models follow examples better than descriptions.
const EXAMPLES: [string, string][] = [
  ["is there any action required of me in my emails this week?", 'inbox_review {"days":7}'],
  ["anything important in my spam?", 'inbox_review {"days":14}'],
  ["did Marc answer about the apartment?", 'email_question {"query":"from:Marc apartment"}'],
  ["find the invoice from Endesa", 'email_search {"query":"from:Endesa invoice"}'],
  ["did Vueling send me anything recently?", 'email_search {"query":"from:Vueling","days":30}'],
  ["what's my booking reference for the Lisbon hotel?", 'email_question {"query":"Lisbon hotel booking"}'],
  ["prep me for my call with Laura", 'meeting_prep {"who":"Laura"}'],
  ["am I free on Thursday afternoon?", "agenda {}"],
  ["schedule a call with the plumber on wednesday at 9", "add_event {}"],
  ["block monday morning for deep work", "add_event {}"],
  ["check my emails for when I registered for the marathon and add it to my calendar", 'event_from_email {"query":"marathon registration"}'],
  ["put the concert I bought tickets for in my calendar", 'event_from_email {"query":"concert tickets"}'],
  ["remind me to pay the electricity bill before it's due", 'reminder_from_email {"query":"electricity bill"}'],
  ["add the deadlines from my emails this week to my reminders", 'deadlines_to_reminders {"days":7}'],
  ["what will the weather be like on my trip?", "trip_weather {}"],
  ["prep me for tomorrow's meetings", "prep_day {}"],
  ["chase everyone who hasn't replied to me", "nudge_all {}"],
  ["when is the Paris marathon next year? add it to my calendar", 'event_from_web {"query":"Paris marathon 2027 date"}'],
  ["tell Laura yes for dinner and put it in my calendar", 'reply_and_add {"who":"Laura","message":"yes for dinner"}'],
  ["remind me to renew my passport next month", "reminder {}"],
  ["don't let me forget to call the bank", "reminder {}"],
  ["how busy am I tomorrow?", "agenda {}"],
  ["anything I need to sign?", 'inbox_review {"days":14}'],
  ["what's my running goal?", 'notes_search {"query":"running goal"}'],
  ["when does the weekly review run?", "schedules {}"],
  ["translate 'thank you' into German", 'unsupported {"reason":"translation"}'],
  ["tell Ana that Thursday works for me", 'draft_reply {"who":"Ana","message":"Thursday works for me"}'],
  ["send a reminder to Marc about the contract", 'nudge {"who":"Marc"}'],
  ["send Ana a few times that work for a call", 'propose_times {"who":"Ana","minutes":30}'],
  ["what am I paying for every month?", "subscriptions {}"],
  ["how often do I water the plants?", 'notes_search {"query":"water the plants"}'],
  ["will it rain in Barcelona tomorrow?", 'weather {"query":"Barcelona"}'],
  ["who won the match last night?", 'web_search {"query":"who won the match last night"}'],
  ["what are the opening hours of the Picasso museum?", 'web_search {"query":"Picasso museum opening hours"}'],
  ["order a pizza", 'unsupported {"reason":"ordering food"}'],
];

export function routerPrompt() {
  return [
    "Route the user's request to ONE skill of their assistant app. Use the user's own words in args; never invent names or facts.",
    "Skills:",
    ...Object.entries(PROMPT_SKILLS).map(([k, v]) => `${k}: ${v}`),
    "Examples:",
    ...EXAMPLES.map(([q, r]) => `"${q}" -> ${r}`),
    'Answer as JSON: {"skill": "...", "args": {...}}',
  ].join("\n");
}

const WHEN = "today|tonight|tomorrow|this (?:week(?:end)?|morning|afternoon|evening)|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";

/**
 * Unmistakable phrasings answered without the model (instantly, and even when it's offline). Narrow on
 * purpose: anything that could mean something else goes to the model.
 */
export function quickRoute(text: string): Route | null {
  const t = text.trim().toLowerCase();
  if (/^(?:please\s+)?remind me (?:to|about|that)\b/.test(t)) return { skill: "reminder", args: {} };
  if (/^who (?:hasn'?t|has not|didn'?t|did not|still hasn'?t) (?:replied|answered|responded|got(?:ten)? back|written back)\b|^who (?:still )?owes me (?:a |an )?(?:reply|answer)\b/.test(t)) return { skill: "waiting_on", args: {} };
  if (/^(?:what'?s|what is|how'?s|how is) the weather\b|^(?:will|is) it (?:going to )?(?:rain|snow)\b|^weather\b/.test(t)) {
    const place = text.match(/\bin ([A-Z][\p{L}\s.'-]{1,40}?)(?=\s+(?:today|tonight|tomorrow|this|next|on|over)\b|[?.!,]|$)/u)?.[1]?.trim();
    return { skill: "weather", args: place ? { query: place } : {} };
  }
  if (new RegExp(`^(?:what'?s|what is|what do i have|what have i got|anything)\\b.*\\b(?:on|in) my (?:calendar|agenda|schedule)\\b|^(?:what'?s|what is) (?:on|planned|happening) (?:${WHEN})\\b|^(?:what do i have|what have i got|am i (?:free|busy)) (?:on |for )?(?:${WHEN})\\b|^(?:what'?s|what is) my (?:schedule|agenda|calendar)\\b`).test(t)) return { skill: "agenda", args: {} };
  return null;
}

/** Asks the local model which skill a request is for (structured JSON, validated). Throws if the model is unavailable. */
export async function routeRequest(ctx: Ctx, text: string, llm: LlmProvider = localLlm(ctx, "background")): Promise<Route & { model: string; ms: number }> {
  llm ??= localLlm(ctx, "background");
  const system = routerPrompt();
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // Cold (model not loaded), reading the instructions can take minutes on a laptop CPU; warm, seconds.
    const out = await llm.generate(system, `Request: ${text}`, { maxTokens: 120, timeoutMs: 600_000, format: ROUTE_JSON_SCHEMA, temperature: 0, keepAlive: "15m" });
    last = out.text;
    try {
      const parsed = RouteSchema.parse(JSON.parse(out.text));
      logActivity(ctx, { actor: "chief_of_staff", kind: "agent_run", agentId: "chief_of_staff", outcome: "info", summary: `Understood the request as “${parsed.skill}” (${out.model}, ${Math.round(out.ms / 1000)} s)` });
      return { ...parsed, model: out.model, ms: out.ms };
    } catch {
      // malformed JSON or an unknown skill: one retry, then the caller falls back
    }
  }
  throw new Error(`The local model's routing answer couldn't be read: ${last.slice(0, 120)}`);
}

export function routerModel(ctx: Ctx) {
  return selectedModel(ctx, "background");
}

let lastWarm = 0;
/**
 * Called when the user opens the command bar: loads the local model and reads the routing instructions
 * in the background (one token answered, nothing done), so understanding the request that follows
 * takes seconds instead of minutes. At most once a minute, and never while the model is busy.
 */
export function warmRouter(ctx: Ctx, busy: boolean, llm: LlmProvider = localLlm(ctx, "background")) {
  if (busy || Date.now() - lastWarm < 60_000) return { warming: false };
  lastWarm = Date.now();
  void llm.generate(routerPrompt(), "Request: hello", { maxTokens: 1, timeoutMs: 600_000, format: ROUTE_JSON_SCHEMA, temperature: 0, keepAlive: "15m" }).catch(() => {});
  return { warming: true };
}

// ---------- skills that answer right away ----------

export interface SkillAnswer {
  reply: string;
  /** `href`: an https link (Google Calendar's pre-filled page, a web source), opened in a new tab. */
  items?: { title: string; detail?: string; href?: string }[];
  section?: "today" | "actions" | "schedules" | "tech" | "permissions" | "knowledge" | "insights";
  actionId?: string;
}

const isConnected = (ctx: Ctx, serviceId: string) => Boolean(one(ctx.db, "SELECT 1 FROM services WHERE id = ? AND connection_state = 'connected'", serviceId));
const denied = (err: unknown) => (err as { code?: string }).code === "POLICY_DENIED";
const tz = () => config().timezone;
const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz() });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz() });
const ago = (iso: string, now: Date) => {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

const STOP = new Set(["my", "the", "a", "an", "next", "when", "is", "s", "what", "time", "appointment", "meeting", "with", "do", "i", "have", "at", "on", "for", "upcoming", "coming", "up"]);
const PERIOD_WORDS = /\b(week|weekend|month|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|afternoon|morning|evening)\b/i;

/** "When is my next dentist appointment?": the first upcoming event whose title matches, within 3 months. */
export async function nextEvent(ctx: Ctx, text: string): Promise<SkillAnswer | null> {
  const m = text.match(/\b(?:when(?:'s| is)? my next|my next|when(?:'s| is) (?:my|the) (?:next )?)\s+([\p{L}][\p{L}' -]{1,50}?)\s*\??$/iu);
  if (!m || PERIOD_WORDS.test(m[1])) return null;
  const words = m[1].toLowerCase().split(/[\s'-]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) return null;
  const from = ctx.now();
  const to = new Date(from.getTime() + 92 * 86_400_000);
  let events: { title: string; starts_at: string; location: string | null }[] = [];
  if (isConnected(ctx, "google-calendar")) events = await callTool(ctx, "calendar", "gcal.range", { from: from.toISOString(), to: to.toISOString() }, new RunBudget(1, 30_000));
  if (!serviceHidden(ctx, "demo-calendar")) events.push(...(await callTool(ctx, "calendar", "calendar.list_events", { from: from.toISOString(), days: 14 }, new RunBudget(1, 5000))));
  const hit = events.sort((a, b) => a.starts_at.localeCompare(b.starts_at)).find((e) => words.some((w) => e.title.toLowerCase().includes(w)));
  if (!hit) return { reply: `I don't see a “${m[1].trim()}” in your calendar over the next 3 months.`, section: "today" };
  return { reply: `Your next ${m[1].trim()}: ${dayLabel(hit.starts_at)} at ${hm(hit.starts_at)} — ${hit.title}${hit.location ? `, ${hit.location}` : ""}.`, section: "today" };
}

/** "What's on my calendar tomorrow?", "am I free next friday afternoon?" */
export async function agenda(ctx: Ctx, text: string): Promise<SkillAnswer> {
  try {
    const next = await nextEvent(ctx, text);
    if (next) return next;
  } catch (err) {
    if (!denied(err)) throw err;
  }
  const range = parseRange(text, ctx.now(), tz());
  const google = isConnected(ctx, "google-calendar");
  const demo = !serviceHidden(ctx, "demo-calendar");
  if (!google && !demo) return { reply: "No calendar is connected yet. Connect Google Calendar in Connections & Permissions.", section: "permissions" };
  let events: { title: string; starts_at: string; ends_at: string; location: string | null }[] = [];
  try {
    if (google) {
      // The synced copy covers yesterday to two weeks ahead; further out, read that window directly.
      const synced = range.from.getTime() >= ctx.now().getTime() - 86_400_000 && range.to.getTime() <= ctx.now().getTime() + 14 * 86_400_000;
      if (synced) {
        const last = one<{ last_sync_at: string | null }>(ctx.db, "SELECT last_sync_at FROM services WHERE id = 'google-calendar'")?.last_sync_at;
        if (!last || ctx.now().getTime() - Date.parse(last) > 10 * 60_000) await callTool(ctx, "calendar", "gcal.sync", {}, new RunBudget(1, 30_000));
        events = all<EventRow>(ctx.db, "SELECT * FROM events WHERE source IN ('google-calendar', 'google-calendar-app') AND starts_at < ? AND ends_at > ? ORDER BY starts_at", range.to.toISOString(), range.from.toISOString());
      } else {
        events = await callTool(ctx, "calendar", "gcal.range", { from: range.from.toISOString(), to: range.to.toISOString() }, new RunBudget(1, 30_000));
      }
    }
    if (demo) {
      const days = Math.max(1, Math.min(14, Math.ceil((range.to.getTime() - range.from.getTime()) / 86_400_000)));
      const rows = await callTool(ctx, "calendar", "calendar.list_events", { from: range.from.toISOString(), days }, new RunBudget(1, 5000));
      events.push(...rows.filter((e) => e.starts_at < range.to.toISOString() && e.ends_at > range.from.toISOString()));
    }
  } catch (err) {
    if (denied(err)) return { reply: "The Calendar agent needs Read on your calendar for that. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  if (!events.length) return { reply: `Nothing on your calendar ${range.label}. You're free.`, section: "today" };
  const multiDay = range.to.getTime() - range.from.getTime() > 86_400_000 + 3_600_000;
  // Overlapping timed events (all-day ones don't count): worth flagging, as a good assistant would.
  const timed = (e: { starts_at: string; ends_at: string }) => Date.parse(e.ends_at) - Date.parse(e.starts_at) < 20 * 3_600_000;
  const clash = (e: (typeof events)[number]) => events.find((o) => o !== e && timed(o) && timed(e) && o.starts_at < e.ends_at && e.starts_at < o.ends_at);
  const clashes = events.filter((e) => clash(e));
  return {
    reply: `${events.length} event${events.length > 1 ? "s" : ""} ${range.label}:${clashes.length ? ` ⚠ ${clashes.length} overlap.` : ""}`,
    items: events.map((e) => {
      const other = clash(e);
      return { title: `${multiDay ? `${dayLabel(e.starts_at)} · ` : ""}${timed(e) ? `${hm(e.starts_at)}–${hm(e.ends_at)}` : "all day"} ${e.title}`, detail: [e.location, other ? `⚠ overlaps with “${other.title}”` : null].filter(Boolean).join(" · ") || undefined };
    }),
    section: "today",
  };
}

/** "Did Marc answer?", "find the invoice from Endesa": Gmail's own search, headers only. */
export async function emailSearch(ctx: Ctx, query: string, days?: number): Promise<SkillAnswer> {
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't search your mail. Connect it in Connections & Permissions.", section: "permissions" };
  const q = `${query.replace(/[\r\n]+/g, " ").trim().slice(0, 250)}${days && !/newer_than:/.test(query) ? ` newer_than:${Math.min(Math.max(days, 1), 365)}d` : ""}`;
  try {
    const rows = await callTool(ctx, "inbox", "gmail.search", { query: q, max: 15 }, new RunBudget(1, 60_000));
    if (!rows.length) return { reply: `No email matches “${q}”.` };
    return {
      reply: `${rows.length} email${rows.length > 1 ? "s" : ""} for “${q}”, newest first:`,
      items: rows.map((r) => ({ title: r.subject, detail: `${parseSender(r.sender).name ?? r.sender.replace(/\s*<[^>]*>/, "")} · ${dayLabel(r.date)} (${ago(r.date, ctx.now())})` })),
    };
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail to search your mail. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
}

/** "Remind me to call mom tomorrow at 6pm": a dashboard reminder, with a due time when one is said. */
export function reminderFromText(ctx: Ctx, text: string): SkillAnswer {
  const task =
    text
      .replace(/^\s*(?:please\s+)?(?:can you\s+)?(?:remind me|set a reminder|add a (?:reminder|to-?do|task)|don'?t let me forget|make sure i (?:don'?t forget|remember))\s*:?\s*(?:to|that|about|for)?\s*/i, "")
      .trim() || text;
  const parsed = parseEventRequest(task, ctx.now(), tz());
  const hasWhen = !("error" in parsed) && parsed.title.toLowerCase() !== task.toLowerCase();
  const title = hasWhen ? parsed.title : task.replace(/[.!?]+$/, "");
  const dueAt = hasWhen ? parsed.startsAt : undefined;
  addReminder(ctx, title.charAt(0).toUpperCase() + title.slice(1), dueAt, "assistant");
  return {
    reply: `Added to your reminders: “${title}”${dueAt ? `, due ${dayLabel(dueAt)}${"error" in parsed || parsed.allDay ? "" : ` at ${hm(dueAt)}`}` : ""}.`,
    section: "today",
  };
}

const BOOKINGS_FRESH_MS = 6 * 3_600_000;

export async function refreshScan(ctx: Ctx, agent: "inbox" | "follow_up", tool: "gmail.scan_bookings" | "gmail.scan_waiting", setting: string): Promise<string | null> {
  if (!isConnected(ctx, "gmail")) return null;
  const last = getSetting(ctx.db, setting);
  if (last && ctx.now().getTime() - Date.parse(last) < BOOKINGS_FRESH_MS) return null;
  try {
    await callTool(ctx, agent, tool, {}, new RunBudget(1, 120_000));
    return null;
  } catch (err) {
    if (denied(err)) return `(I couldn't re-check your mail: the ${agent === "inbox" ? "Inbox" : "Follow-up"} agent needs Read on Gmail, so this is from the last check.)`;
    throw err;
  }
}

/** "Who hasn't answered me?" */
export async function waitingOn(ctx: Ctx): Promise<SkillAnswer> {
  const note = await refreshScan(ctx, "follow_up", "gmail.scan_waiting", "insights.scanned.waiting");
  const rows = all<{ recipient: string; subject: string; sent_at: string }>(ctx.db, `SELECT recipient, subject, sent_at FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at`);
  if (!rows.length) return { reply: `Nobody owes you an answer right now (threads where you wrote last, 3+ days ago).${note ? ` ${note}` : ""}`, section: "insights" };
  return {
    reply: `${rows.length} conversation${rows.length > 1 ? "s" : ""} where you're still waiting for an answer. Say “nudge <name>” to draft a polite follow-up.${note ? ` ${note}` : ""}`,
    items: rows.map((r) => ({ title: r.subject, detail: `to ${r.recipient.replace(/\s*<[^>]*>/, "")} · ${ago(r.sent_at, ctx.now())}` })),
    section: "insights",
  };
}

/** "Nudge Priya": a follow-up draft in the same thread, for approval. */
export async function nudge(ctx: Ctx, who: string): Promise<SkillAnswer> {
  await refreshScan(ctx, "follow_up", "gmail.scan_waiting", "insights.scanned.waiting");
  const w = who.toLowerCase().trim();
  const rows = all<{ thread_id: string; recipient: string; subject: string }>(ctx.db, `SELECT thread_id, recipient, subject FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at`);
  const match = rows.find((r) => r.recipient.toLowerCase().includes(w));
  if (!match) {
    return {
      reply: rows.length ? `I don't see a conversation with “${who}” waiting for an answer. These are:` : `No conversation is waiting for an answer, so there's nobody to nudge.`,
      items: rows.map((r) => ({ title: r.subject, detail: `to ${r.recipient.replace(/\s*<[^>]*>/, "")}` })),
      section: "insights",
    };
  }
  try {
    const { actionId } = await proposeNudge(ctx, match.thread_id);
    return { reply: `Drafted a follow-up to ${match.recipient.replace(/\s*<[^>]*>/, "")} about “${match.subject}”. Review it in the Action Queue; nothing is sent until you approve it.`, actionId, section: "actions" };
  } catch (err) {
    if (err instanceof InsightError) return { reply: err.message, section: "permissions" };
    throw err;
  }
}

/** "What trips do I have coming up?" */
export async function trips(ctx: Ctx): Promise<SkillAnswer> {
  const note = await refreshScan(ctx, "inbox", "gmail.scan_bookings", "insights.scanned.bookings");
  const flights = upcomingFlights(ctx, tz());
  const others = all<{ kind: string; subject: string; received_at: string }>(ctx.db, `SELECT kind, subject, received_at FROM bookings WHERE kind != 'flight'${demoRowsFilter()} ORDER BY received_at DESC LIMIT 10`);
  if (!flights.length && !others.length) return { reply: `I found no trips or bookings in your mail (confirmations from the last 6 months).${note ? ` ${note}` : ""}`, section: "insights" };
  const fmtDate = (d: { y: number; m: number; d: number }) => new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return {
    reply: `${flights.length} upcoming flight${flights.length === 1 ? "" : "s"}${others.length ? ` and ${others.length} other booking${others.length === 1 ? "" : "s"}` : ""}. Say “add my flights to my calendar” to add them.${note ? ` ${note}` : ""}`,
    items: [
      ...flights.map((f) => ({ title: `✈ ${f.from} → ${f.to} · ${fmtDate(f.date)}${f.time ? ` ${f.time}` : ""}`, detail: [f.airline, f.ref].filter(Boolean).join(" · ") || undefined })),
      ...others.map((b) => ({ title: b.subject, detail: `${b.kind} · confirmation received ${ago(b.received_at, ctx.now())}` })),
    ],
    section: "insights",
  };
}

const RECEIPTS = `newer_than:120d -category:promotions subject:(${["receipt", "invoice", '"your payment"', '"payment received"', "renewal", "renewed", "subscription", "factura", "recibo", "facture", "reçu", "rebut", "abonnement", "suscripción", "subscripció", "cobro", "prélèvement", "pagament"].join(" OR ")})`;
const AMOUNT = /(?:€|EUR|\$|USD|£|GBP)\s?\d+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?\s?(?:€|EUR|USD|GBP)/i;

/**
 * What the user actually pays for regularly: receipts and invoices (headers only) from the last four
 * months, grouped by sender; a sender who billed in two or more different months is recurring.
 */
export async function recurringPayments(ctx: Ctx): Promise<{ recurring: { title: string; detail: string }[]; once: number } | null> {
  if (!isConnected(ctx, "gmail")) return null;
  const rows = await callTool(ctx, "inbox", "gmail.search", { query: RECEIPTS, max: 50 }, new RunBudget(1, 120_000));
  const bySender = new Map<string, { name: string; months: Set<string>; amounts: string[]; last: string }>();
  for (const r of rows) {
    const { name, email } = parseSender(r.sender);
    const key = (email ?? r.sender).split("@").at(-1)!.toLowerCase();
    const cur = bySender.get(key) ?? { name: (name ?? key).replace(/[\s,;:]+$/, ""), months: new Set<string>(), amounts: [], last: r.date };
    cur.months.add(r.date.slice(0, 7));
    const amount = r.subject.match(AMOUNT)?.[0];
    if (amount) cur.amounts.push(amount);
    if (r.date > cur.last) cur.last = r.date;
    bySender.set(key, cur);
  }
  const recurring = [...bySender.values()]
    .filter((v) => v.months.size >= 2)
    .sort((a, b) => b.months.size - a.months.size || b.last.localeCompare(a.last))
    .map((v) => ({ title: `💳 ${v.name}`, detail: `receipts in ${v.months.size} of the last 4 months${v.amounts.length ? ` · last amount ${v.amounts[0]}` : ""} · latest ${dayLabel(v.last)}` }));
  return { recurring, once: [...bySender.values()].filter((v) => v.months.size < 2).length };
}

/** "Which subscriptions am I paying for?" */
export async function subscriptions(ctx: Ctx): Promise<SkillAnswer> {
  let paid: Awaited<ReturnType<typeof recurringPayments>> = null;
  try {
    paid = await recurringPayments(ctx);
  } catch (err) {
    if (!denied(err)) throw err;
  }
  const last = getSetting(ctx.db, "insights.scanned.subscriptions");
  let note = "";
  if (isConnected(ctx, "gmail") && (!last || ctx.now().getTime() - Date.parse(last) > 7 * 86_400_000)) {
    try {
      await callTool(ctx, "inbox", "gmail.audit_subscriptions", {}, new RunBudget(1, 300_000));
    } catch (err) {
      if (!denied(err)) throw err;
      note = " (The Inbox agent needs Read on Gmail to re-check, so this is from the last audit.)";
    }
  }
  const rows = all<{ name: string; sender: string; messages: number; looks_paid: number }>(ctx.db, `SELECT name, sender, messages, looks_paid FROM subscriptions WHERE 1 = 1${demoRowsFilter()} ORDER BY messages DESC LIMIT 40`);
  const parts = [
    paid
      ? paid.recurring.length
        ? `${paid.recurring.length} sender${paid.recurring.length === 1 ? " bills" : "s bill"} you regularly (receipts or invoices in 2+ of the last 4 months).`
        : "I found no recurring receipts or invoices in the last 4 months."
      : "Connect Gmail (and give the Inbox agent Read) to see what you pay for from your receipts.",
    paid?.once ? `${paid.once} other sender${paid.once === 1 ? "" : "s"} sent a single receipt.` : "",
    rows.length ? `You also get newsletters from ${rows.length} senders you could unsubscribe from (Inbox insights).` : "",
    note,
  ].filter(Boolean);
  return {
    reply: parts.join(" "),
    items: [...(paid?.recurring ?? []), ...rows.slice(0, paid?.recurring.length ? 5 : 12).map((r) => ({ title: `📰 ${r.name}`, detail: `${r.messages} newsletter email${r.messages === 1 ? "" : "s"} · ${r.sender}` }))],
    section: "insights",
  };
}

/** "Weather in Barcelona tomorrow?", "will it rain this weekend?": Open-Meteo, up to 7 days. */
export async function weatherAnswer(ctx: Ctx, text: string, place: string | null): Promise<SkillAnswer> {
  const range = parseRange(text, ctx.now(), tz());
  let f;
  try {
    f = await callTool(ctx, "calendar", "weather.lookup", { place: place && place.length >= 2 ? place.slice(0, 80) : null }, new RunBudget(1, 20_000));
  } catch (err) {
    if (denied(err)) return { reply: "Weather is off. Pick your city in Settings → Weather (Open-Meteo, free) and give the Calendar agent Read on it.", section: "permissions" };
    throw err;
  }
  const localDate = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: tz() }); // YYYY-MM-DD
  const first = localDate(range.from);
  const last = localDate(new Date(range.to.getTime() - 1));
  const days = f.days.filter((d) => d.date >= first && d.date <= last);
  if (!days.length) return { reply: `I only have the forecast for the next 7 days (${f.location}), and ${range.label} is further out.` };
  const fmt = (d: (typeof f.days)[number]) => `${d.summary}, ${d.min}–${d.max}°C${d.rainChance != null ? `, ${d.rainChance}% chance of rain` : ""}`;
  const dayName = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  if (days.length === 1) return { reply: `${f.location}, ${range.label}: ${fmt(days[0])}. (${f.attribution})` };
  return { reply: `${f.location}, ${range.label}:`, items: days.map((d) => ({ title: dayName(d.date), detail: fmt(d) })) };
}

const ANSWER_SYSTEM = [
  "You answer the user's question using ONLY the emails given below, which come from their own mailbox.",
  "Quote the exact facts (dates, times, amounts, references, addresses) and cite the email number like [1].",
  "If the emails don't contain the answer, say so plainly in one sentence. Do not guess. Answer in English, in at most three sentences.",
  UNTRUSTED_DATA_RULES,
].join("\n");

const WEB_SYSTEM = [
  "You answer the user's question using ONLY the web search results and pages given below.",
  "Give the answer first, with the key facts (names, dates, numbers), and cite sources like [1]. Prefer the most recent and most official sources; say when sources disagree.",
  "If the sources don't answer the question, say so plainly in one sentence. Do not guess. Answer in English, in at most four sentences of plain text (no Markdown, no notes).",
  UNTRUSTED_DATA_RULES,
].join("\n");

/**
 * "Who won the final?", "opening hours of the Picasso museum": the user's own SearXNG finds pages, the top
 * three are read (public https pages only), and the local model answers with numbered sources.
 */
export async function webAnswer(ctx: Ctx, question: string, query: string, progress: (s: string) => void, llm: LlmProvider = localLlm(ctx, "background")): Promise<SkillAnswer> {
  const found = await webSources(ctx, query, progress);
  if (!("results" in found)) return found;
  progress("Writing the answer…");
  const today = ctx.now().toISOString().slice(0, 10);
  const sources = found.results.map((r) => fenceUntrusted(`web result [${r.n}] ${new URL(r.url).hostname}`, `Title: ${r.title}\nSnippet: ${r.snippet}${found.pages.has(r.n) ? `\nPage text: ${found.pages.get(r.n)}` : ""}`)).join("\n\n");
  const out = await llm.generate(WEB_SYSTEM, `Today is ${today}.\nQuestion: ${question}\n\n${sources}`, { maxTokens: 260, timeoutMs: 1_200_000 });
  // Plain text: the answer is shown as is, so Markdown emphasis would appear as asterisks.
  const plain = out.text.replace(/\*\*|__/g, "").replace(/^\s*\*\(?(Note|Disclaimer)[\s\S]*$/im, "").trim();
  return { reply: plain, items: webItems(found.results) };
}

/** Reads the top matches of a Gmail search (skipping AI-directed text) for the local model. */
export async function readMatches(ctx: Ctx, query: string, max: number, progress: (s: string) => void) {
  const rows = await callTool(ctx, "inbox", "gmail.search", { query, max: 8 }, new RunBudget(1, 60_000));
  const read: { n: number; sender: string; subject: string; date: string; text: string }[] = [];
  for (const r of rows.filter((x) => !x.bulk || /booking|reserv|ticket|invoice|factura|order|confirm/i.test(x.subject)).slice(0, max)) {
    progress(`Reading “${r.subject.slice(0, 60)}”…`);
    const m = await callTool(ctx, "inbox", "gmail.read_by_id", { gmailId: r.id }, new RunBudget(1, 60_000));
    if (isAiDirected(injectionFlags(`${m.subject}\n${m.text}`))) continue;
    // ~2,500 characters each: enough for the facts, which are near the top; the model's limits are generous.
    read.push({ n: read.length + 1, sender: r.sender, subject: r.subject, date: r.date, text: m.text.slice(0, 2500) });
  }
  return read;
}

// Emails arrive in several languages while requests are in English: widen the main words of a search
// with their French, Spanish and Catalan forms (Gmail ignores accents).
const TRANSLATIONS: [RegExp, string[]][] = [
  [/^races?$/, ["race", "carrera", "cursa", "course"]],
  [/^marathons?$/, ["marathon", "maraton", "marato"]],
  [/^(registration|registered|register|sign(ed)?[- ]?up|enrol(l?ment|led)?)$/, ["registration", "inscripcion", "inscripcio", "inscription"]],
  [/^concerts?$/, ["concert", "concierto"]],
  [/^tickets?$/, ["ticket", "tickets", "entrada", "entradas", "entrades", "billet", "billets"]],
  [/^appointments?$/, ["appointment", "cita", "rendez-vous", "rdv"]],
  [/^(booking|bookings|reservation|reservations)$/, ["booking", "reservation", "reserva", "reservation"]],
  [/^dinner$/, ["dinner", "cena", "sopar", "diner"]],
  [/^wedding$/, ["wedding", "boda", "casament", "mariage"]],
  [/^(class|classes|course|courses|lesson)$/, ["class", "course", "clase", "classe", "cours", "curs"]],
  [/^exams?$/, ["exam", "examen"]],
  [/^(match|game)$/, ["match", "partido", "partit"]],
  [/^(invoice|bill)$/, ["invoice", "bill", "factura", "facture"]],
];
export function widenQuery(query: string): string {
  const out = query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (/[:()"]/.test(w) || /^(OR|AND)$/.test(w)) return w; // Gmail operators stay as written
      const forms = TRANSLATIONS.find(([re]) => re.test(w.toLowerCase()))?.[1];
      return forms ? `(${[...new Set(forms)].join(" OR ")})` : w;
    })
    .join(" ");
  return out.length <= 250 ? out : query.slice(0, 250);
}

/** Search words from a request when the model gave none: what's left after the request's own wording. */
function searchWords(text: string) {
  const filler = /^(from|my|the|emails?|mail|inbox|check|find|look|when|what|where|did|do|i|it|its|a|an|to|in|into|on|for|and|then|add|put|calendar|agenda|please|can|you|could|me|that|this|was|is|of|up|at|with)$/i;
  return text.split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length > 1 && !filler.test(w)).slice(0, 6).join(" ");
}

const EVENT_SYSTEM = [
  "The user wants an event in their calendar. From the sources below (their emails, or web pages), find the event they ask about (one they registered for, booked, bought tickets for or were invited to, or the public event they name) and give:",
  "found: true only if a source states the DATE the event takes place (not the date an email was sent or a registration was made).",
  "source: the number of the source that gives the date.",
  "title: a short calendar title in English with the event's own name (e.g. 'Barcelona Marathon', 'Coldplay concert', 'Dentist').",
  "date: the day of the event as YYYY-MM-DD. start and end: HH:MM in 24-hour time if the source gives them, else empty. location: the place if given, else empty.",
  "Use only what the sources say; never guess a date or a time. The sources may be in any language.",
  UNTRUSTED_DATA_RULES,
  "Answer with JSON only.",
].join("\n");
const EVENT_SCHEMA = {
  type: "object",
  properties: { found: { type: "boolean" }, source: { type: "integer" }, title: { type: "string" }, date: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" } },
  required: ["found", "source", "title", "date", "start", "end", "location"],
};
const FoundEvent = z.object({
  found: z.boolean(),
  source: z.number().int().catch(1),
  title: z.string().default(""),
  date: z.string().default(""),
  start: z.string().default(""),
  end: z.string().default(""),
  location: z.string().default(""),
});

export type EventFromEmail = { prepared: PreparedEvent; source: string } | SkillAnswer;

/** One email or web page given to the model: its fence label, its text, and how the answer cites it. */
interface SourceDoc {
  n: number;
  label: string;
  body: string;
  cite: string;
  /** Fallback title when the model gives none. */
  title: string;
}

const ymdOf = (d: { y: number; m: number; d: number }) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

/** "YYYY-MM-DD" as a real calendar day, or null. */
export function realDay(s: string): { y: number; m: number; d: number } | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const date = { y: +m[1], m: +m[2], d: +m[3] };
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return t.getUTCMonth() === date.m - 1 && t.getUTCDate() === date.d ? date : null;
}

/**
 * The local model pulls the event's date, time and place out of the sources; code checks the date
 * (a real day, not already over) and that the calendar doesn't already have it.
 */
async function extractEvent(ctx: Ctx, text: string, docs: SourceDoc[], items: SkillAnswer["items"], llm: LlmProvider, progress: (s: string) => void): Promise<EventFromEmail> {
  progress("Finding the date in those sources…");
  const tzName = tz();
  const today = localToday(ctx.now(), tzName);
  const out = await llm.generate(
    EVENT_SYSTEM,
    `Today is ${ymdOf(today)}.\nRequest: ${text}\n\n${docs.map((d) => fenceUntrusted(d.label, d.body)).join("\n\n")}`,
    { maxTokens: 200, timeoutMs: 1_200_000, format: EVENT_SCHEMA, temperature: 0 },
  );
  let f: z.infer<typeof FoundEvent>;
  try {
    f = FoundEvent.parse(JSON.parse(out.text));
  } catch {
    return { reply: "I read the matching sources but couldn't make out the event's date. They're listed below.", items };
  }
  const date = realDay(f.date);
  if (!f.found || !date) return { reply: "I found sources that seem related, but none of them gives the date of the event, so I didn't add anything. They're listed below.", items };
  const src = docs.find((d) => d.n === f.source) ?? docs[0];
  const title = f.title.replace(/\s+/g, " ").trim().slice(0, 120) || src.title.slice(0, 120);
  const location = f.location.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const prepared = eventOn(title, location, date, f.start.trim(), f.end.trim(), tzName, ctx.now());
  const when = `${new Date(prepared.startsAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: tzName })}${prepared.allDay ? " (all day: no time given)" : `, ${hm(prepared.startsAt)}–${hm(prepared.endsAt)}`}`;
  if (ymdOf(date) < ymdOf(today)) return { reply: `The event I found, “${title}” on ${when}, is already over, so I didn't add it. Source: ${src.cite}.`, items };
  const day = eventOn("x", null, date, "", "", tzName, ctx.now());
  const sameDay = all<{ title: string }>(ctx.db, `SELECT title FROM events WHERE starts_at < ? AND ends_at > ?${demoRowsFilter()}`, day.endsAt, day.startsAt);
  // The synced copy covers two weeks; further out (an invitation already accepted), ask Google for that day.
  if (isConnected(ctx, "google-calendar")) {
    try {
      sameDay.push(...(await callTool(ctx, "calendar", "gcal.range", { from: day.startsAt, to: day.endsAt }, new RunBudget(1, 30_000))));
    } catch {
      // Unreadable now: the approval step still shows the event before anything is added.
    }
  }
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
  const twin = sameDay.find((e) => words.some((w) => e.title.toLowerCase().includes(w)));
  if (twin) return { reply: `“${title}” on ${when} is already in your calendar (“${twin.title}”). Source: ${src.cite}.`, items };
  return { prepared, source: `${title}, ${when}${location ? `, ${location}` : ""}. Found in ${src.cite}.` };
}

/**
 * "Check when I registered for the race and add it to my calendar": search the mail, read the best
 * matches, and pull out the event (the caller proposes it).
 */
export async function findEventInEmail(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm: LlmProvider = localLlm(ctx, "background")): Promise<EventFromEmail> {
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
  const q = widenQuery((query.replace(/[\r\n]+/g, " ").trim() || searchWords(text)).slice(0, 250));
  progress("Searching your mail…");
  let read;
  try {
    read = await readMatches(ctx, q, 4, progress);
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail for that. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  if (!read.length) return { reply: `I found no email matching “${query || searchWords(text)}”. Try naming the event or who it's from (e.g. “add the marathon from RunReg to my calendar”).` };
  const docs = read.map((r) => ({
    n: r.n,
    label: `email [${r.n}] from ${r.sender}`,
    body: `Subject: ${r.subject}\nDate sent: ${r.date.slice(0, 10)}\n\n${r.text}`,
    cite: `“${r.subject}” (${parseSender(r.sender).name ?? r.sender}, ${dayLabel(r.date)})`,
    title: r.subject,
  }));
  const items = read.map((r) => ({ title: `[${r.n}] ${r.subject}`, detail: `${parseSender(r.sender).name ?? r.sender} · ${dayLabel(r.date)}` }));
  return extractEvent(ctx, text, docs, items, llm, progress);
}

/** Web results and the text of the top pages (public https only), for the local model. */
async function webSources(ctx: Ctx, query: string, progress: (s: string) => void): Promise<{ results: WebResult[]; pages: Map<number, string> } | SkillAnswer> {
  if (!check(ctx, "knowledge", "web-search", "read")) return { reply: "Web search is off. To allow it, give the Knowledge agent Read on “Web search” in Connections & Permissions.", section: "permissions" };
  progress("Searching the web (privately, through your own SearXNG)…");
  let results: WebResult[];
  try {
    results = await callTool(ctx, "knowledge", "web.search", { query: query.slice(0, 200) }, new RunBudget(1, 60_000));
  } catch (err) {
    if (denied(err)) return { reply: "The Knowledge agent needs Read on Web search for that. Grant it in Connections & Permissions.", section: "permissions" };
    return { reply: err instanceof Error ? err.message : "The web search failed." };
  }
  if (!results.length) return { reply: `The web search for “${query}” found nothing.` };
  const pages = new Map<number, string>();
  for (const r of results.slice(0, 3)) {
    progress(`Reading ${new URL(r.url).hostname}…`);
    try {
      const text = await callTool(ctx, "knowledge", "web.read", { url: r.url }, new RunBudget(1, 30_000));
      if (!isAiDirected(injectionFlags(text))) pages.set(r.n, text.slice(0, 2500));
    } catch {
      // Unreadable page (blocked, not https, too slow): its snippet still counts.
    }
  }
  return { results, pages };
}

const webItems = (results: WebResult[]) => results.slice(0, 5).map((r) => ({ title: `[${r.n}] ${r.title}`, detail: new URL(r.url).hostname, href: r.url }));

/** "When is the Barcelona marathon 2027? Add it to my calendar": the event from public web pages. */
export async function findEventOnWeb(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm: LlmProvider = localLlm(ctx, "background")): Promise<EventFromEmail> {
  const found = await webSources(ctx, query, progress);
  if (!("results" in found)) return found;
  const docs = found.results.map((r) => ({
    n: r.n,
    label: `web result [${r.n}] ${new URL(r.url).hostname}`,
    body: `Title: ${r.title}\nSnippet: ${r.snippet}${found.pages.has(r.n) ? `\nPage text: ${found.pages.get(r.n)}` : ""}`,
    cite: `${r.title} (${new URL(r.url).hostname})`,
    title: r.title,
  }));
  return extractEvent(ctx, text, docs, webItems(found.results), llm, progress);
}

/** "When is my hotel check-in in Lisbon?": find the emails, read them, answer with sources. */
export async function emailQuestion(ctx: Ctx, question: string, query: string, progress: (s: string) => void, llm: LlmProvider = localLlm(ctx, "background")): Promise<SkillAnswer> {
  query = query.replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
  progress("Searching your mail…");
  let read;
  try {
    read = await readMatches(ctx, widenQuery(query), 3, progress);
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail for that. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  if (!read.length) return { reply: `I found no email matching “${query}”, so I can't answer that from your mail.` };
  progress("Writing the answer…");
  const out = await llm.generate(ANSWER_SYSTEM, `Question: ${question}\n\n${read.map((r) => fenceUntrusted(`email [${r.n}] from ${r.sender}`, `Subject: ${r.subject}\nDate: ${r.date.slice(0, 10)}\n\n${r.text}`)).join("\n\n")}`, { maxTokens: 200, timeoutMs: 1_200_000 });
  return {
    reply: out.text.trim(),
    items: read.map((r) => ({ title: `[${r.n}] ${r.subject}`, detail: `${parseSender(r.sender).name ?? r.sender} · ${dayLabel(r.date)}` })),
  };
}

const PREP_SYSTEM = [
  "You prepare the user for a meeting or event. From the calendar entry, recent emails and notes below, write a short brief in English:",
  "1. When and where. 2. What it's about and the latest from the emails (who said what, decisions). 3. Open questions or things to bring or prepare.",
  "Use only the material given; say when something isn't known. Cite emails like [1]. Keep it under 150 words.",
  UNTRUSTED_DATA_RULES,
].join("\n");

/** "Prep me for my meeting with Laura": the event, recent emails with her, related notes, summarized. */
export async function meetingPrep(ctx: Ctx, text: string, who: string, progress: (s: string) => void, llm: LlmProvider = localLlm(ctx, "background")): Promise<SkillAnswer> {
  progress("Looking at your calendar…");
  const w = who.toLowerCase();
  const range = parseRange(/\b(today|tomorrow|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2} \w+)\b/i.test(text) ? text : "the next 14 days", ctx.now(), tz());
  const upcoming = await agenda(ctx, text).catch(() => null);
  const events = (upcoming?.items ?? []).filter((e) => e.title.toLowerCase().includes(w));
  const event = events[0] ?? null;
  let read: Awaited<ReturnType<typeof readMatches>> = [];
  if (isConnected(ctx, "gmail")) {
    try {
      read = await readMatches(ctx, `"${who.replace(/"/g, "")}" newer_than:90d`, 3, progress);
    } catch (err) {
      if (!denied(err)) throw err;
    }
  }
  let notes: { title: string; text: string }[] = [];
  if (check(ctx, "knowledge", "demo-notes", "read")) {
    const res = await retrieve(ctx, { query: who, provider: "lexical", k: 2 }, undefined, "chief_of_staff");
    notes = res.passages.map((p) => ({ title: p.title, text: p.text }));
  }
  if (!event && !read.length && !notes.length) return { reply: `I found nothing about “${who}” in your calendar (${range.label}), recent email or notes.` };
  progress("Writing the brief…");
  const material = [
    // Invitations are written by other people: the calendar entry is untrusted data like an email.
    event ? fenceUntrusted("calendar entry", `${event.title}${event.detail ? ` (${event.detail})` : ""}`) : `Calendar: no event matching “${who}” found.`,
    ...read.map((r) => fenceUntrusted(`email [${r.n}] from ${r.sender}`, `Subject: ${r.subject}\nDate: ${r.date.slice(0, 10)}\n\n${r.text}`)),
    ...notes.map((n) => fenceUntrusted(`note: ${n.title}`, n.text)),
  ].join("\n\n");
  const out = await llm.generate(PREP_SYSTEM, `Meeting with or about: ${who}\n\n${material}`, { maxTokens: 260, timeoutMs: 1_200_000 });
  return {
    reply: out.text.trim(),
    items: [...(event ? [{ title: `📅 ${event.title}`, detail: event.detail }] : []), ...read.map((r) => ({ title: `[${r.n}] ${r.subject}`, detail: `${parseSender(r.sender).name ?? r.sender} · ${dayLabel(r.date)}` })), ...notes.map((n) => ({ title: `📝 ${n.title}` }))],
    section: "today",
  };
}

/** What the assistant can do, for an honest "not yet" answer. */
export const CAN_DO =
  "I can: review your recent email (or spam) for things that need you, search your mail or answer questions from it, answer about your calendar, add events, flights or an event found in your email or on the web to your calendar, set reminders (also from a bill or deadline in your mail), draft replies and nudges for your approval (one or everyone), list who owes you an answer, your trips and subscriptions, give the weather (also for your next trip), search the web privately, answer from your notes, prepare a meeting or a whole day, run the briefing or weekly review.";

// ---------- skills that run in the background (the local model writes or reads) ----------

/**
 * "Tell Ana that Thursday works": find Ana's latest email, have the local model write the reply in that
 * email's language saying what the user asked, and propose it as a Gmail draft for approval.
 */
export async function draftReplyFree(ctx: Ctx, who: string, message: string, progress: (s: string) => void): Promise<SkillAnswer> {
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't find the email to reply to. Connect it in Connections & Permissions.", section: "permissions" };
  progress(`Finding the latest email from ${who}…`);
  const name = who.replace(/["\\]/g, "").trim();
  let rows;
  try {
    rows = await callTool(ctx, "inbox", "gmail.search", { query: `from:"${name}" newer_than:90d`, max: 1 }, new RunBudget(1, 60_000));
    if (!rows.length) rows = await callTool(ctx, "inbox", "gmail.search", { query: `"${name}" newer_than:90d -in:sent`, max: 1 }, new RunBudget(1, 60_000));
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail to find that email. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  const msg = rows[0];
  if (!msg) return { reply: `I couldn't find an email from “${who}” in the last 90 days to reply to.` };
  const { name: senderName, email } = parseSender(msg.sender);
  if (!email) return { reply: "I couldn't read that sender's address." };
  progress(`Reading “${msg.subject}” and writing the reply…`);
  const read = await callTool(ctx, "inbox", "gmail.read_by_id", { gmailId: msg.id }, new RunBudget(1, 60_000));
  // An email that talks to an AI is not shown to the model: the reply is written from your words only.
  const aiDirected = isAiDirected(injectionFlags(`${msg.subject}\n${read.text}`));
  const lang = detectLanguage(read.text);
  const written = await writeReply(draftLlmFor(ctx, lang, localLlm(ctx, "background")), msg.sender, msg.subject, aiDirected ? "" : read.text, senderName, aboutMePrompt(ctx), lang, message);
  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  if (!isConnected(ctx, "gmail-drafts")) {
    return { reply: `Here's a reply to ${senderName ?? email} (“${msg.subject}”). Connect “Gmail drafts” to have it placed in Gmail for you; for now, copy it:`, items: [{ title: subject, detail: written.reply }] };
  }
  try {
    const out = await callTool(
      ctx,
      "follow_up",
      "actions.propose",
      {
        serviceId: "gmail-drafts",
        kind: "email_draft",
        title: `Gmail draft: reply to ${senderName ?? email} — ${msg.subject}`.slice(0, 200),
        payload: { to: email, subject, body: written.reply, ...(msg.threadId ? { threadId: msg.threadId } : {}), ...(read.messageId ? { inReplyTo: read.messageId } : {}) },
        idempotencyKey: `ask-draft:${msg.id}:${ctx.now().toISOString().slice(0, 16)}`,
      },
      new RunBudget(1, 5000),
    );
    return {
      reply: `Drafted a reply to ${senderName ?? email} about “${msg.subject}”${aiDirected ? " (from your words only: that email contained instructions aimed at an AI)" : ""}. Review it in the Action Queue; once approved it lands in your Gmail Drafts, never sent automatically.`,
      items: [{ title: subject, detail: written.reply }],
      actionId: out.actionId,
      section: "actions",
    };
  } catch (err) {
    if (denied(err)) return { reply: "The Follow-up agent can't prepare Gmail drafts yet (grant it in Connections & Permissions). Here's the text to copy:", items: [{ title: subject, detail: written.reply }], section: "permissions" };
    throw err;
  }
}

/** "What did I note about X?": search the notes, then a grounded answer with sources, by the local model. */
export async function notesAnswer(ctx: Ctx, query: string, progress: (s: string) => void): Promise<SkillAnswer> {
  if (!check(ctx, "knowledge", "demo-notes", "read")) return { reply: "The Knowledge agent has no read access to your notes. Grant it in Connections & Permissions.", section: "permissions" };
  const provider = nanoModelInstalled() && knowledgeStats(ctx).localVectors > 0 ? "local-semantic" : "lexical";
  progress("Searching your notes…");
  const res = await retrieve(ctx, { query, provider, k: 4, answer: true }, localLlm(ctx, "background"), "chief_of_staff");
  if (!res.passages.length) return { reply: `I found nothing about “${query}” in your notes.`, section: "knowledge" };
  return {
    reply: res.answer?.text ?? `Top notes for “${query}”:`,
    items: res.passages.map((p) => ({ title: p.title, detail: `${p.text.slice(0, 160)}${p.text.length > 160 ? "…" : ""}${p.flags.length ? " ⚠ contains instruction-like text (treated as data)" : ""}` })),
    section: "tech",
  };
}
