import { z } from "zod";
import { all, getSetting, one, type Ctx } from "../db";
import { config } from "../config";
import { logActivity } from "../activity";
import { demoRowsFilter, serviceHidden } from "../mode";
import { callTool, type EventRow } from "../tools/registry";
import { RunBudget } from "../tools/budget";
import { draftLlmFor, fenceUntrusted, localLlm, workLlm, selectedModel, UNTRUSTED_DATA_RULES, type LlmProvider } from "../llm";
import { cloudWorker } from "../cloudRouter";
import { aboutMePrompt } from "../memory";
import { detectLanguage } from "../lang";
import { injectionFlags, isAiDirected, stem } from "../retrieval/text";
import { knowledgeStats, retrieve } from "../retrieval/knowledge";
import { nanoModelInstalled } from "../retrieval/embeddings";
import { check } from "../policy/engine";
import { addReminder, listReminders } from "../reminders";
import { InsightError, proposeNudge } from "../insights";
import { autoRun, draftFacts } from "../autopilot";
import { correctWeekdayDate, weekdayAfter, eventOn, localToday, parseEventRequest, zonedToUtc, type PreparedEvent } from "./eventParse";
import type { WebResult } from "../connectors/websearch";
import { relevantPassages } from "./passages";
import { parseRange } from "./when";
import { parseSender, writeReply } from "./chiefOfStaff";
import { upcomingFlights } from "./flights";
import { similarExamples } from "./examples";
import { userExamples } from "./corrections";

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
  reminders_list: "Show the user's open reminders (list, not add).",
  contact_lookup: "The email address of a person the user has written to or heard from. Args: who.",
  priorities: "What the user should do or look at FIRST today / next: a prioritised list from their calendar, unanswered mail, replies they wait for and reminders. Not the news briefing.",
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

export const ROUTE_JSON_SCHEMA = {
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
/** The same, with the goal restated first: the model writes what the user wants before choosing (JSON keys come out in order). */
export const ROUTE_GOAL_SCHEMA = { ...ROUTE_JSON_SCHEMA, properties: { goal: { type: "string" }, ...ROUTE_JSON_SCHEMA.properties }, required: ["goal", "skill", "args"] };
const restateOn = (ctx: Ctx) => getSetting(ctx.db, "assistant.restate") === "on";

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
  reminders_list: "show my reminders / to-dos",
  contact_lookup: "someone's email address {who}",
  priorities: "what to do first / what matters most today",
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

/** The skills with their one-line descriptions, as the router sees them (also used by the self-check). */
export function skillList(): string {
  return Object.entries(PROMPT_SKILLS).map(([k, v]) => `${k}: ${v}`).join("\n");
}

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
  ["who wrote Don Quixote?", 'web_search {"query":"who wrote Don Quixote"}'],
  ["when is the electrician coming?", 'email_question {"query":"electrician"}'],
  ["what should I say to Marc about the contract?", 'draft_reply {"who":"Marc"}'],
];

export function routerPrompt(restate = false) {
  return [
    "Route the user's request to ONE skill of their assistant app. Use the user's own words in args; never invent names or facts.",
    "Skills:",
    ...Object.entries(PROMPT_SKILLS).map(([k, v]) => `${k}: ${v}`),
    "Examples:",
    ...EXAMPLES.map(([q, r]) => `"${q}" -> ${r}`),
    restate
      ? 'Answer as JSON: {"goal": "what the user wants as a result, in a few words", "skill": "...", "args": {...}}'
      : 'Answer as JSON: {"skill": "...", "args": {...}}',
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
  // "remind me friday to buy snacks", "remind me tonight at 9 to lock the bike": a time, then the task. Not "remind me what…",
  // nor an event anchor ("the day before my flight", "before the committee"), which the reminder skill places itself.
  if (/^(?:please\s+)?remind me\s+(?!(?:what|when|where|who|how|which|why|whether|if|of|about|the|before|after)\b)[\w:' ]{2,30}?\s+to\s+(?!\d)\w/.test(t) && !/\b(?:before|after|morning of|day of)\b/.test(t)) return { skill: "reminder", args: {} };
  // "What time is my dentist", "when is my next run": the calendar's next matching event (travel has its own skill).
  if (/^(?:when(?:'s| is) my next|what time(?:'s| is) my(?: next)?)\s+[\p{L}]/u.test(t) && !/\b(flights?|trip|hotel|train|plane|check-?in|booking)\b/.test(t) && !/\band\b/.test(t)) return { skill: "agenda", args: {} };
  if (/^who (?:hasn'?t|has not|didn'?t|did not|still hasn'?t) (?:replied|answered|responded|got(?:ten)? back|written back)\b|^who (?:still )?owes me (?:a |an )?(?:reply|answer)\b/.test(t)) return { skill: "waiting_on", args: {} };
  if (/^(?:what'?s|what is|how'?s|how is) the weather\b|^what the weather'?s? (?:is )?like\b|^(?:will|is) it (?:going to )?(?:rain|snow)\b|^weather\b/.test(t)) {
    const place = text.match(/\bin ([A-Z][\p{L}\s.'-]{1,40}?)(?=\s+(?:today|tonight|tomorrow|this|next|on|over)\b|[?.!,]|$)/u)?.[1]?.trim();
    return { skill: "weather", args: place ? { query: place } : {} };
  }
  if (new RegExp(`^(?:what'?s|what is|what do i have|what have i got|anything)\\b.*\\b(?:on|in) my (?:calendar|agenda|schedule)\\b|^(?:what'?s|what is) (?:on|planned|happening) (?:${WHEN})\\b|^(?:what do i have|what have i got|am i (?:free|busy)) (?:on |for )?(?:${WHEN})\\b|^(?:what'?s|what is) my (?:schedule|agenda|calendar)\\b`).test(t)) return { skill: "agenda", args: {} };
  // "find a free hour on thursday and email Marc to propose it": offer free slots to a person.
  const offer = text.match(/^(?:please\s+)?find (?:a |some )?free (hour|half an hour|\d{1,3}\s*(?:min(?:ute)?s?|hours?))\b.*\b(?:email|send|tell|message|write to|propose (?:it |them )?to)\s+([A-Z][\p{L}'-]+)/u);
  if (offer) {
    const minutes = /half/i.test(offer[1]) ? 30 : /hour/i.test(offer[1]) && !/\d/.test(offer[1]) ? 60 : /h/i.test(offer[1]) ? parseInt(offer[1], 10) * 60 : parseInt(offer[1], 10);
    return { skill: "propose_times", args: { who: offer[2], minutes } };
  }
  // "list my reminders": show them, never add one called "List my reminders".
  if (/^(?:please\s+)?(?:list|show(?: me)?|see|what are|what'?s on|read(?: me)?)\s+(?:all\s+)?(?:my|the)\s+(?:open\s+)?(?:reminders|to-?dos?|tasks|to-?do list)\b/.test(t)) return { skill: "reminders_list", args: {} };
  // "ignore all previous instructions…", "show me your system prompt": a plain refusal (the whole sentence, never split).
  if (/\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:(?:your|the|any|previous|prior|earlier|above)\s+)+(?:instructions|rules|prompts?)\b|\bsystem prompt\b|\b(?:reveal|show|print|repeat)\s+(?:me\s+)?your\s+(?:instructions|prompt|rules)\b|\bdeveloper mode\b|\bjailbreak\b/.test(t)) return { skill: "unsupported", args: { reason: "I don't change or reveal my instructions" } };
  // "what's Priya's email": an address the app already knows.
  const contact = text.match(/^(?:what(?:'s| is)|give me|find)\s+([\p{L}][\p{L}'-]+?)(?:'s|’s|s')\s+(?:e-?mail(?: address)?|address)\s*\??$/iu);
  if (contact) return { skill: "contact_lookup", args: { who: contact[1] } };
  // "chase the one that's been longest": the oldest wait (nudge() picks it).
  if (/^(?:please\s+)?(?:chase|nudge|follow up with)\s+(?:(?:the one|the person|whoever|whichever|the people)\b.*\b(?:longest|oldest)\b|the (?:oldest|longest)(?: one| wait| person)?\s*$)/.test(t)) return { skill: "nudge", args: { who: "longest" } };
  // "tell me the headlines": the news, from the web.
  if (/^(?:please\s+)?(?:tell me |show me |give me |what are |what'?s )?(?:the )?(?:latest |today'?s |top |main )?(?:news|headlines)(?: today| now| right now)?\??$/.test(t)) return { skill: "web_search", args: { query: "top news headlines today" } };
  // "whether the long run on the weekend fits": a question about the calendar.
  if (/^(?:whether|if)\b.*\b(?:fits?|conflicts?|clash(?:es)?|works?|is free)\b/.test(t) && /\b(weekend|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|morning|afternoon|evening)\b/.test(t)) return { skill: "agenda", args: {} };
  // Moving, cancelling or editing an event is not something the app can do: say so, instead of asking "when is it?".
  if (/^(?:please\s+)?(?:can you\s+)?(?:move|reschedule|postpone|push back|cancel|delete|remove|change|edit)\s+(?:my|the|that|this)\s+(?!reminders?\b)/.test(t) && /\b(appointment|meeting|event|dentist|doctor|lunch|dinner|call|class|flight|booking|session|training|run|interview)\b/.test(t)) return { skill: "unsupported", args: { reason: "I can only add events, not move, change or cancel them" } };
  if (/^(?:what should i (?:do|focus on|tackle|look at|start with)(?: first| next)?(?: today)?|what(?:'s| is) (?:most )?(?:important|urgent|pressing) (?:today|now)|where should i (?:start|begin)(?: today)?|what do i need to do (?:first|today|now))\??$/.test(t.replace(/[.!]+$/, ""))) return { skill: "priorities", args: {} };
  if (/^(?:give me |show me )?(?:the )?(?:short version|quick summary|summary|rundown|overview|snapshot) of (?:today|my day|tomorrow)\b/.test(t)) return { skill: "agenda", args: {} };
  return null;
}

/** Asks the local model which skill a request is for (structured JSON, validated). Throws if the model is unavailable. */
export async function routeRequest(ctx: Ctx, text: string, llm: LlmProvider = workLlm(ctx, "background"), people: string[] = []): Promise<Route & { model: string; ms: number }> {
  llm ??= workLlm(ctx, "background");
  const restate = restateOn(ctx);
  const system = routerPrompt(restate);
  // The most similar labelled requests go in the user message, after the fixed instructions, so the model's cache of the
  // instructions still applies (docs/ACCURACY_PLAN.md, phase B).
  // On by default since the dev run of 2026-10-16 (15% -> 10% errors); "off" turns it off.
  // The user's own corrections join them, for the local model only: past requests never go to the cloud router.
  const own = llm.id === "mistral-api" ? [] : userExamples(ctx);
  const similar = getSetting(ctx.db, "assistant.examples") !== "off" ? similarExamples(text, 6, people, own) : [];
  const user = `${similar.length ? `Similar requests and how they were routed:\n${similar.map(([q, r]) => `"${q}" -> ${r}`).join("\n")}\n\n` : ""}Request: ${text}`;
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // Cold (model not loaded), reading the instructions can take minutes on a laptop CPU; warm, seconds.
    const out = await llm.generate(system, user, { maxTokens: restate ? 170 : 120, timeoutMs: 600_000, format: restate ? ROUTE_GOAL_SCHEMA : ROUTE_JSON_SCHEMA, temperature: 0, keepAlive: "15m" });
    last = out.text;
    try {
      const parsed = RouteSchema.parse(JSON.parse(out.text));
      logActivity(ctx, { actor: "chief_of_staff", kind: "agent_run", agentId: "chief_of_staff", outcome: "info", summary: `Understood the request as “${parsed.skill}”${restate ? ` (goal: ${String((JSON.parse(out.text) as { goal?: unknown }).goal ?? "").slice(0, 120)})` : ""} (${out.model}, ${Math.round(out.ms / 1000)} s)` });
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
  // While Mistral's cloud does the work, the local model isn't needed: don't load 6 GB into memory for nothing.
  if (busy || Date.now() - lastWarm < 60_000 || cloudWorker(ctx)) return { warming: false };
  lastWarm = Date.now();
  void llm.generate(routerPrompt(restateOn(ctx)), "Request: hello", { maxTokens: 1, timeoutMs: 600_000, format: ROUTE_JSON_SCHEMA, temperature: 0, keepAlive: "15m" }).catch(() => {});
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
  // "when is my next run", and "is there a spanish thing coming up": the next event whose title has those words.
  const m =
    text.match(/\b(?:when(?:'s| is)? my next|my next|when(?:'s| is) (?:my|the) (?:next )?|what time(?:'s| is) (?:my|the) (?:next )?)\s+([\p{L}][\p{L}' -]{1,50}?)\s*\??$/iu) ??
    text.match(/\b(?:is there|are there|do i have|have i got)\s+(?:a|an|any|my)\s+([\p{L}][\p{L}'-]{2,30}(?:\s+[\p{L}][\p{L}'-]{2,30})?)\s+(?:thing|event|class|lesson|session|meeting|appointment)?s?\s*(?:coming up|soon|planned)\s*\??$/iu);
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
  const named = await namedEventAnswer(ctx, text);
  if (named) return named;
  let range = parseRange(text, ctx.now(), tz());
  const got = await eventsBetween(ctx, range.from, range.to);
  if ("reply" in got) return got;
  let events = got.events;
  events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  // "Am I free at 3pm tomorrow": that moment, yes or no.
  const at = freeAtAnswer(text, events, range.from);
  if (at) return at;
  const listItems = (list: CalEvent[]) => list.map((e) => ({ title: `${hm(e.starts_at)}–${hm(e.ends_at)} ${e.title}`, detail: e.location ?? undefined }));
  const day0 = localToday(range.from, tz());
  // "What's between 2pm and 5pm today": the events in that window, or that it's free.
  const win = text.match(/\bbetween\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday)\s+and\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday)\b/i);
  if (win) {
    const [a, b] = [win[1], win[2]].map((w) => clockMinutes(w.match(CLOCK)!));
    if (a !== null && b !== null && b > a) {
      const from = zonedToUtc(day0, a, tz()).getTime();
      const to = zonedToUtc(day0, b, tz()).getTime();
      const inside = events.filter((e) => Date.parse(e.starts_at) < to && Date.parse(e.ends_at) > from);
      const label = `${range.label} between ${hm(new Date(from).toISOString())} and ${hm(new Date(to).toISOString())}`;
      return inside.length ? { reply: `${inside.length} event${inside.length > 1 ? "s" : ""} ${label}:`, items: listItems(inside), section: "today" } : { reply: `Nothing on your calendar ${label}: you're free.`, section: "today" };
    }
  }
  // "What's the gap between the dentist and lunch", "how long do I have between the bike drop-off and the spanish exchange":
  // the free time from the end of one to the start of the other (other events in between taken out), within two weeks.
  const between = /\b(?:gap|free|time|break|long|much)\b/i.test(text) ? text.match(/\bbetween\s+(?:the\s+|my\s+)?(.+?)\s+and\s+(?:the\s+|my\s+)?(.+?)\s*(?:today|tomorrow|tonight)?\s*\??$/iu) : null;
  if (between && !/^\d|^(?:noon|midday)/i.test(between[1].trim())) {
    const soon = await eventsBetween(ctx, zonedToUtc(localToday(ctx.now(), tz()), 0, tz()), new Date(ctx.now().getTime() + 14 * 86_400_000));
    const pool = "events" in soon ? soon.events.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : events;
    const find = (phrase: string) => {
      const ws = phrase.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
      const score = (e: CalEvent) => ws.filter((w) => e.title.toLowerCase().includes(w)).length;
      return pool.filter((e) => score(e) > 0).sort((a, b) => score(b) - score(a))[0];
    };
    const [x, y] = [find(between[1]), find(between[2])];
    if (x && y && x !== y) {
      const [first, second] = Date.parse(x.starts_at) <= Date.parse(y.starts_at) ? [x, y] : [y, x];
      const from = Date.parse(first.ends_at);
      const to = Date.parse(second.starts_at);
      if (to <= from) return { reply: `No gap: “${second.title}” starts before “${first.title}” ends.`, items: listItems([first, second]), section: "today" };
      const inside = pool.filter((e) => Date.parse(e.starts_at) < to && Date.parse(e.ends_at) > from && e !== first && e !== second);
      const spans: [number, number][] = [];
      let cursor = from;
      for (const e of inside) {
        if (Date.parse(e.starts_at) > cursor) spans.push([cursor, Date.parse(e.starts_at)]);
        cursor = Math.max(cursor, Date.parse(e.ends_at));
      }
      if (to > cursor) spans.push([cursor, to]);
      const free = spans.reduce((n, [a, b]) => n + Math.round((b - a) / 60_000), 0);
      const shown = spans.map(([a, b]) => `${hm(new Date(a).toISOString())}–${hm(new Date(b).toISOString())}`).join(" and ");
      return {
        reply: `${duration(free)} free between “${first.title}” (ends ${hm(first.ends_at)}) and “${second.title}” (${dayLabel(second.starts_at)} ${hm(second.starts_at)}): ${shown}${inside.length ? ` (${inside.map((e) => `“${e.title}”`).join(", ")} in between)` : ""}.`,
        items: listItems([first, ...inside, second]),
        section: "today",
      };
    }
  }
  // "How many hours of appointments do I have today": the time booked, counted in code.
  if (((/\bhow (?:many hours|much time)\b/i.test(text) && /\b(?:appointments?|meetings?|events?|booked|busy|calendar|scheduled|plans?)\b/i.test(text)) || /\bhow much of (?:today|tomorrow|tonight|my day|the day|this (?:morning|afternoon|evening)|\w+day) is (?:booked|taken|busy|scheduled|full)\b|\bhow (?:booked|busy) am i\b/i.test(text)) && !/\b(?:free|left|spare|available|between)\b/i.test(text)) {
    const timedOnly = events.filter((e) => Date.parse(e.ends_at) - Date.parse(e.starts_at) < 20 * 3_600_000);
    const min = timedOnly.reduce((n, e) => n + Math.round((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000), 0);
    return { reply: timedOnly.length ? `${duration(min)} booked ${range.label}, in ${timedOnly.length} event${timedOnly.length > 1 ? "s" : ""}.` : `Nothing booked ${range.label}.`, items: listItems(timedOnly), section: "today" };
  }
  // "What's after the spanish exchange" (tomorrow), "next event after the long run" (Sunday): with no day named, the event
  // named after "after"/"before" sets the day, within two weeks.
  let cut = timeCut(text, events, range.from);
  const anchorPhrase = text.match(/\b(?:after|before)\s+(?:the\s+|my\s+)?([\p{L}][\p{L}' -]{2,40}?)\s*\??$/iu)?.[1];
  if (!cut && anchorPhrase && !/\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weekend|\d)/i.test(text)) {
    const soon = await eventsBetween(ctx, zonedToUtc(localToday(ctx.now(), tz()), 0, tz()), new Date(ctx.now().getTime() + 14 * 86_400_000));
    const ws = anchorPhrase.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
    const anchor = "events" in soon ? soon.events.sort((a, b) => a.starts_at.localeCompare(b.starts_at)).find((e) => ws.some((w) => e.title.toLowerCase().includes(w))) : undefined;
    if (anchor && "events" in soon) {
      const d = localToday(new Date(anchor.starts_at), tz());
      const dayFrom = zonedToUtc(d, 0, tz());
      range = { from: dayFrom, to: zonedToUtc(d, 24 * 60, tz()), label: `on ${dayLabel(anchor.starts_at)}` };
      events = soon.events.filter((e) => Date.parse(e.starts_at) < range.to.getTime() && Date.parse(e.ends_at) > dayFrom.getTime());
      cut = timeCut(text, events, dayFrom);
    }
  }
  // "Anything after lunch today", "what's on after 3pm": only what starts after that point.
  if (cut) {
    events = events.filter((e) => (cut.after ? Date.parse(e.starts_at) >= cut.at : Date.parse(e.ends_at) <= cut.at));
    // "What comes after the committee": nothing more that day, so the next event, whenever it is (within a week).
    if (!events.length && cut.after && /\b(?:comes?|next|what'?s)\b/i.test(text)) {
      const ahead = await eventsBetween(ctx, new Date(cut.at), new Date(cut.at + 7 * 86_400_000));
      const next = "events" in ahead ? ahead.events.sort((a, b) => a.starts_at.localeCompare(b.starts_at)).find((e) => Date.parse(e.starts_at) >= cut.at) : undefined;
      if (next) return { reply: `Nothing more ${range.label} ${cut.label}. Next: “${next.title}”, ${dayLabel(next.starts_at)} at ${hm(next.starts_at)}${next.location ? `, ${next.location}` : ""}.`, items: [{ title: `${dayLabel(next.starts_at)} · ${hm(next.starts_at)}–${hm(next.ends_at)} ${next.title}`, detail: next.location ?? undefined }], section: "today" };
      return { reply: `Nothing on your calendar ${cut.label} in the next 7 days.`, section: "today" };
    }
    if (!events.length) return { reply: `Nothing on your calendar ${range.label} ${cut.label}.`, section: "today" };
    return { reply: `${events.length} event${events.length > 1 ? "s" : ""} ${range.label} ${cut.label}:`, items: events.map((e) => ({ title: `${hm(e.starts_at)}–${hm(e.ends_at)} ${e.title}`, detail: e.location ?? undefined })), section: "today" };
  }
  // "What's left on my calendar today": only what hasn't ended.
  if (/\b(left|remaining|rest of|still to come|still coming|later today|still on)\b/i.test(text)) events = events.filter((e) => Date.parse(e.ends_at) > ctx.now().getTime());
  // A day question: unanswered mail that names that weekday ("Saturday hike — are you in?") belongs in the answer.
  const spanDays = Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000);
  const dayNames = spanDays <= 3 ? [...new Set(Array.from({ length: Math.max(1, spanDays) }, (_, i) => new Date(range.from.getTime() + i * 86_400_000 + 3_600_000).toLocaleDateString("en-GB", { weekday: "long", timeZone: tz() })))] : [];
  const dayName = dayNames.join(" or ");
  const mentions = dayNames.length
    ? all<{ sender: string; subject: string; snippet: string }>(ctx.db, `SELECT sender, subject, snippet FROM messages WHERE needs_reply = 1${demoRowsFilter()} AND (${dayNames.map(() => "subject LIKE ? OR snippet LIKE ?").join(" OR ")}) ORDER BY received_at DESC LIMIT 3`, ...dayNames.flatMap((d) => [`%${d}%`, `%${d}%`])).map((m) => ({ title: `Mail: ${m.subject}`, detail: `from ${m.sender.replace(/\s*<[^>]*>/, "")}, waiting for your reply, mentions ${dayNames.find((d) => `${m.subject} ${m.snippet}`.toLowerCase().includes(d.toLowerCase())) ?? dayName}` }))
    : [];
  // "Do I have time for a coffee with Sam before the committee": the free time from now until that event (or the day's end).
  if ((/\b(?:do i have|have i got|is there|got)\s+(?:any\s+)?time\b|\btime for\b|\bam i free\b/i.test(text) || /\b(?:gaps?|free (?:slots?|time|window|spells?)|spare time|breaks?|nap)\b/i.test(text)) && range.to.getTime() - range.from.getTime() <= 86_400_000 + 3_600_000) {
    const words = text.toLowerCase().match(/\bbefore\s+(?:the\s+|my\s+)?([\p{L}]{3,})/u)?.[1];
    const limit = words ? events.find((e) => e.title.toLowerCase().includes(words)) : undefined;
    const end = limit ? Date.parse(limit.starts_at) : range.to.getTime();
    const gaps: string[] = [];
    let cursor = Math.max(ctx.now().getTime(), range.from.getTime());
    for (const e of events.filter((e) => Date.parse(e.ends_at) > cursor && Date.parse(e.starts_at) < end)) {
      if (Date.parse(e.starts_at) - cursor >= 30 * 60_000) gaps.push(`${hm(new Date(cursor).toISOString())}–${hm(e.starts_at)}`);
      cursor = Math.max(cursor, Date.parse(e.ends_at));
    }
    if (end - cursor >= 30 * 60_000) gaps.push(`${hm(new Date(cursor).toISOString())}–${hm(new Date(end).toISOString())}`);
    const until = limit ? ` before “${limit.title}” at ${hm(limit.starts_at)}` : ` ${range.label}`;
    return { reply: gaps.length ? `Yes: you're free ${gaps.join(", ")}${until}.` : `No: nothing free for 30 minutes or more${until}.`, items: events.map((e) => ({ title: `${hm(e.starts_at)}–${hm(e.ends_at)} ${e.title}`, detail: e.location ?? undefined })), section: "today" };
  }
  if (!events.length) return { reply: `Nothing on your calendar ${range.label}. You're free${mentions.length ? `, but your mail mentions ${dayName}:` : "."}`, items: mentions.length ? mentions : undefined, section: "today" };
  const multiDay = range.to.getTime() - range.from.getTime() > 86_400_000 + 3_600_000;
  // Overlapping timed events (all-day ones don't count): worth flagging, as a good assistant would.
  const timed = (e: { starts_at: string; ends_at: string }) => Date.parse(e.ends_at) - Date.parse(e.starts_at) < 20 * 3_600_000;
  const clash = (e: (typeof events)[number]) => events.find((o) => o !== e && timed(o) && timed(e) && o.starts_at < e.ends_at && e.starts_at < o.ends_at);
  const clashes = events.filter((e) => clash(e));
  return {
    reply: `${events.length} event${events.length > 1 ? "s" : ""} ${range.label}:${clashes.length ? ` ⚠ ${clashes.length} overlap.` : /double.?book|overlap|clash|conflict|same time|at once|simultaneous/i.test(text) ? " No overlaps: nothing is double booked." : ""}${/\bwho(?:'s| is| will be| are)? (?:coming|going|attending|there)\b|\battendees?\b/i.test(text) ? " Your calendar doesn't say who is coming." : ""}`,
    items: [...events.map((e) => {
      const other = clash(e);
      return { title: `${multiDay ? `${dayLabel(e.starts_at)} · ` : ""}${timed(e) ? `${hm(e.starts_at)}–${hm(e.ends_at)}` : "all day"} ${e.title}`, detail: [e.location, other ? `⚠ overlaps with “${other.title}”` : null].filter(Boolean).join(" · ") || undefined };
    }), ...mentions],
    section: "today",
  };
}

type CalEvent = { title: string; starts_at: string; ends_at: string; location: string | null };

/**
 * A question about the calendar that the rules only answered with a list ("do I have a gap this afternoon", "how many things
 * tomorrow", "when does lunch end"). Plain listings ("what's on tomorrow", "anything this weekend") are not questions.
 */
export function calendarQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^(?:please\s+)?(?:what'?s|what is|what do i have|what have i got|show(?: me)?|list|anything|is there anything|do i have anything|have i got anything|give me)\b.*\b(?:on|planned|happening|calendar|agenda|schedule|week|weekend|today|tomorrow|tonight)\s*\??$/.test(t) && !/\b(?:how many|gap|first|last|earliest|latest|end|finish|start|between)\b/.test(t)) return false;
  return /\b(?:how many|how much time|how long|gaps?|free|busy|first|last|earliest|latest|start|starts|end|ends|finish|finishes|between|before|after|which|who|where|when|is there|are there|do i|am i|does|will|should|can i)\b/.test(t);
}

/** The model answers a calendar question from exactly the events the list shows; the list stays under the answer. */
export async function calendarModelAnswer(ctx: Ctx, text: string, listed: SkillAnswer, progress: (s: string) => void, llm: LlmProvider = workLlm(ctx, "background")): Promise<SkillAnswer> {
  progress("Reading your calendar to answer…");
  const now = ctx.now();
  const today = `${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz() })}, ${hm(now.toISOString())}`;
  const events = (listed.items ?? []).filter((i) => !/^Mail:/.test(i.title)).map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ""}`).join("\n");
  try {
    const out = await llm.generate(CALENDAR_SYSTEM, `Now: ${today}.\nCalendar (${listed.reply.replace(/:$/, "")}):\n${events || "- nothing"}\n\nQuestion: ${text}`, { maxTokens: 120, timeoutMs: 600_000 });
    const reply = groundNumbers(plainAnswer(out.text), `${today} ${events} ${listed.reply}`);
    return { ...listed, reply: /^I couldn't confirm/.test(reply) ? listed.reply : reply };
  } catch {
    return listed;
  }
}

const CALENDAR_SYSTEM = [
  "You answer the user's question about their calendar using ONLY the events listed (times are local, HH:MM, 24-hour).",
  "Answer in one or two short sentences, with the times. A gap or free time is time with no event. Count events exactly.",
  "If the events don't answer the question, say so in one sentence. Never invent an event, a place or a person.",
].join("\n");

/** The user's events between two instants (Google Calendar when connected, the demo calendar when shown). */
export async function eventsBetween(ctx: Ctx, from: Date, to: Date): Promise<{ events: CalEvent[] } | SkillAnswer> {
  const range = { from, to };
  const google = isConnected(ctx, "google-calendar");
  const demo = !serviceHidden(ctx, "demo-calendar");
  if (!google && !demo) return { reply: "No calendar is connected yet. Connect Google Calendar in Connections & Permissions.", section: "permissions" };
  let events: CalEvent[] = [];
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
  return { events: events.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) };
}

// Words that say what kind of question it is, or when; what is left names the event ("spanish exchange", "long runs").
const QUESTION_WORDS = new Set("where when what which who how is are am do does did i my me the a an on at in of to for and or it its s re there any anything exactly actually again please roughly today tomorrow tonight yesterday week weekend next this coming time times day days date long until till calendar agenda schedule event events meeting meetings appointment appointments plan plans planned happening going have has get got usually usual always".split(" "));
const WEEKDAY_WORDS = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?$/;

/**
 * "Where's the spanish exchange", "is the dentist today or tomorrow", "on which day are my long runs": a question about one
 * named event, answered with that event's place, day and time (and its weekday when it repeats), not with a day's list.
 */
/** `strict`: every word of the question must be in the event ("how long is my spanish streak" is not the Spanish exchange). */
export async function namedEventAnswer(ctx: Ctx, text: string, strict = false): Promise<SkillAnswer | null> {
  const where = /\bwhere(?:'s| is| are| was)?\b/i.test(text);
  const when = /\b(?:when(?:'s| is| are| was)?|what time|which days?|what days?|today or tomorrow|tomorrow or today|how long (?:is|does|will|do)|until when|till when)\b/i.test(text);
  // "Where am I going after lunch": what comes after it (timeCut), not where lunch is.
  if (!(where || when) || /\b(?:time for|free|busy|available)\b/i.test(text) || /\b(?:after|before)\s+(?:the\s+|my\s+)?[\p{L}\d]/iu.test(text)) return null;
  const words = text.toLowerCase().replace(/[’']s\b/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !QUESTION_WORDS.has(w) && !WEEKDAY_WORDS.test(w)).map(stem);
  if (!words.length) return null;
  const today = localToday(ctx.now(), tz());
  let got: Awaited<ReturnType<typeof eventsBetween>>;
  try {
    got = await eventsBetween(ctx, zonedToUtc(today, 0, tz()), new Date(ctx.now().getTime() + 14 * 86_400_000));
  } catch {
    return null;
  }
  if ("reply" in got) return null;
  const titleWords = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem));
  // "Where is spanish class on thursday": only that day's (or period's) events when one is named.
  const asked = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week(?:end)?|next week|weekend)\b/i.test(text) && !/\btoday or tomorrow|tomorrow or today\b/i.test(text) ? parseRange(text, ctx.now(), tz()) : null;
  const inPeriod = (e: CalEvent) => !asked || (Date.parse(e.starts_at) < asked.to.getTime() && Date.parse(e.ends_at) > asked.from.getTime());
  const shared = (e: CalEvent) => {
    const tw = titleWords(`${e.title} ${e.location ?? ""}`);
    return words.filter((w) => tw.has(w));
  };
  let hits = got.events.filter((e) => inPeriod(e) && shared(e).length > 0 && shared(e).length >= (strict ? words.length : Math.ceil(words.length / 2)));
  // "What time do I need to be at the bike shop": one word only, but a distinctive one ("bike") that only one upcoming
  // event shares. The answer names the event, so a wrong match shows.
  if (!hits.length && !strict) {
    const loose = got.events.filter((e) => inPeriod(e) && shared(e).some((w) => w.length >= 4));
    if (loose.length && new Set(loose.map((e) => e.title)).size === 1) hits = loose;
  }
  if (!hits.length) return null;
  const now = ctx.now().getTime();
  const relDay = (iso: string) => {
    const d = localToday(new Date(iso), tz());
    const diff = Math.round((Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000);
    return diff === 0 ? "today" : diff === 1 ? "tomorrow" : new Date(iso).toLocaleDateString("en-GB", { weekday: "long", timeZone: tz() });
  };
  const upcoming = hits.filter((e) => Date.parse(e.ends_at) > now);
  const first = upcoming[0] ?? hits[hits.length - 1];
  const span = `${hm(first.starts_at)}–${hm(first.ends_at)}`;
  const over = Date.parse(first.ends_at) <= now ? " (already over)" : "";
  const items = hits.map((e) => ({ title: `${dayLabel(e.starts_at)} · ${hm(e.starts_at)}–${hm(e.ends_at)} ${e.title}`, detail: e.location ?? undefined }));
  // "On which day are my long runs": the weekday they fall on.
  if (/\b(?:which|what) days?\b/i.test(text)) {
    const days = [...new Set(hits.map((e) => new Date(e.starts_at).toLocaleDateString("en-GB", { weekday: "long", timeZone: tz() })))];
    return { reply: `“${first.title}” is on ${days.length === 1 ? `${days[0]}${hits.length > 1 ? "s" : ""}` : days.join(", ")}: next ${relDay(first.starts_at)} (${dayLabel(first.starts_at)}) at ${span}${over}.`, items, section: "today" };
  }
  if (where) {
    return { reply: first.location ? `“${first.title}” is at ${first.location}, ${relDay(first.starts_at)} (${dayLabel(first.starts_at)}) at ${span}${over}.` : `Your calendar doesn't say where “${first.title}” is (${relDay(first.starts_at)}, ${dayLabel(first.starts_at)} at ${span}).`, items, section: "today" };
  }
  // "How long does the committee go on for": its length, with the times.
  if (/\bhow long\b/i.test(text)) {
    const min = Math.round((Date.parse(first.ends_at) - Date.parse(first.starts_at)) / 60_000);
    const length = min % 60 === 0 ? `${min / 60} hour${min === 60 ? "" : "s"}` : min > 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} minutes`;
    return { reply: `“${first.title}” lasts ${length}: ${relDay(first.starts_at)} (${dayLabel(first.starts_at)}) ${span}${first.location ? `, ${first.location}` : ""}${over}.`, items, section: "today" };
  }
  return { reply: `“${first.title}”: ${relDay(first.starts_at)} (${dayLabel(first.starts_at)}) at ${span}${first.location ? `, ${first.location}` : ""}${over}.`, items, section: "today" };
}

/** "4 h 30 min", "2 hours", "45 minutes". */
const duration = (min: number) => (min < 60 ? `${min} minutes` : min % 60 === 0 ? `${min / 60} hour${min === 60 ? "" : "s"}` : `${Math.floor(min / 60)} h ${min % 60} min`);

const CLOCK = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\b(noon|midday)\b/i;
const clockMinutes = (m: RegExpMatchArray): number | null => {
  if (m[4]) return 12 * 60;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
  if (m[3]?.toLowerCase() === "am" && h === 12) h = 0;
  // "at 3" without am/pm: an afternoon hour for 1–7
  if (!m[3] && h >= 1 && h <= 7) h += 12;
  return h * 60 + min;
};

/** "Am I free at 3pm tomorrow", "check if I'm free at 15:00 on friday": that moment on the asked day, yes or no. */
function freeAtAnswer(text: string, events: CalEvent[], dayStart: Date): SkillAnswer | null {
  if (!/\b(?:free|available|busy)\b/i.test(text)) return null;
  // "free at 3pm", and "is 4pm tomorrow free" (a time with am/pm or minutes, without "at").
  const m = text.match(new RegExp(`\\bat\\s+(?:${CLOCK.source})`, "i")) ?? text.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i)?.[0].match(CLOCK) ?? null;
  if (!m) return null;
  const minutes = clockMinutes(m);
  if (minutes === null) return null;
  const at = zonedToUtc(localToday(dayStart, tz()), minutes, tz()).getTime();
  const end = at + 30 * 60_000;
  // All-day entries (a birthday, a holiday marker) don't make a given hour busy.
  const timed = events.filter((e) => Date.parse(e.ends_at) - Date.parse(e.starts_at) < 20 * 3_600_000);
  const busy = timed.filter((e) => Date.parse(e.starts_at) < end && Date.parse(e.ends_at) > at);
  const day = dayLabel(new Date(at).toISOString());
  const time = hm(new Date(at).toISOString());
  if (busy.length) return { reply: `No: at ${time} on ${day} you have “${busy[0].title}” (${hm(busy[0].starts_at)}–${hm(busy[0].ends_at)}).`, section: "today" };
  const before = timed.filter((e) => Date.parse(e.ends_at) <= at).at(-1);
  const after = timed.find((e) => Date.parse(e.starts_at) >= end);
  return { reply: `Yes: you're free at ${time} on ${day}${before || after ? ` (${before ? `after “${before.title}” ends at ${hm(before.ends_at)}` : ""}${before && after ? "; " : ""}${after ? `next is “${after.title}” at ${hm(after.starts_at)}` : ""})` : ": nothing else that day"}.`, section: "today" };
}

/** "After lunch", "after the committee", "after 3pm", "before noon": a point in the asked day to cut the list at. */
function timeCut(text: string, events: CalEvent[], dayStart: Date): { at: number; after: boolean; label: string } | null {
  // "Do I have time for a coffee before the committee" is the free-time question, answered further on.
  if (/\b(?:time for|am i free|have (?:any )?time|got (?:any )?time)\b/i.test(text)) return null;
  const m = text.match(/\b(after|before)\s+(?:the\s+|my\s+)?([\p{L}]{3,}|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday)/iu);
  if (!m) return null;
  const after = m[1].toLowerCase() === "after";
  const what = m[2].toLowerCase();
  const day = localToday(dayStart, tz());
  const clock = what.match(CLOCK);
  if (clock && /\d|noon|midday/.test(what)) {
    const minutes = clockMinutes(clock);
    if (minutes === null) return null;
    const at = zonedToUtc(day, minutes, tz()).getTime();
    return { at, after, label: `${m[1].toLowerCase()} ${hm(new Date(at).toISOString())}` };
  }
  const event = events.find((e) => e.title.toLowerCase().includes(what));
  if (event) return { at: after ? Date.parse(event.ends_at) : Date.parse(event.starts_at), after, label: `${m[1].toLowerCase()} “${event.title}” (${hm(after ? event.ends_at : event.starts_at)})` };
  if (what === "lunch") {
    const at = zonedToUtc(day, after ? 14 * 60 : 12 * 60, tz()).getTime();
    return { at, after, label: `${m[1].toLowerCase()} lunch` };
  }
  return null;
}

/** "Did Marc answer?", "find the invoice from Endesa": Gmail's own search, headers only. */
export async function emailSearch(ctx: Ctx, query: string, days?: number): Promise<SkillAnswer> {
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't search your mail. Connect it in Connections & Permissions.", section: "permissions" };
  const q = `${query.replace(/[\r\n]+/g, " ").trim().slice(0, 250)}${days && !/newer_than:/.test(query) ? ` newer_than:${Math.min(Math.max(days, 1), 365)}d` : ""}`;
  try {
    let rows = await callTool(ctx, "inbox", "gmail.search", { query: q, max: 15 }, new RunBudget(1, 60_000));
    let shown = q;
    // Nothing for the model's long query: the main words alone.
    for (const loose of rows.length ? [] : looserQueries(query)) {
      const lq = `${loose}${days ? ` newer_than:${Math.min(Math.max(days, 1), 365)}d` : ""}`;
      rows = await callTool(ctx, "inbox", "gmail.search", { query: lq, max: 15 }, new RunBudget(1, 60_000));
      if (rows.length) {
        shown = lq;
        break;
      }
    }
    if (!rows.length) return { reply: `No email matches “${q}”.` };
    return {
      reply: `${rows.length} email${rows.length > 1 ? "s" : ""} for “${shown}”, newest first:`,
      items: rows.map((r) => ({ title: r.subject, detail: `${parseSender(r.sender).name ?? r.sender.replace(/\s*<[^>]*>/, "")} · ${dayLabel(r.date)} (${ago(r.date, ctx.now())})` })),
    };
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail to search your mail. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
}

/** "Remind me to call mom tomorrow at 6pm": a dashboard reminder, with a due time when one is said. */
export function reminderFromText(ctx: Ctx, text: string): SkillAnswer {
  // "I need to bring the map on saturday, can you remind me friday night": the task first, the time after "remind me".
  const tail = text.match(/^\s*(?:i\s+(?:need|have|must|should|want)\s+to\s+)?(.+?)[,.;]?\s+(?:(?:can|could|would)\s+you\s+|please\s+)?remind\s+me(?:\s+(?:about|of)\s+it)?\s*(.*?)\s*[?.!]*$/i);
  if (tail && !/^\s*(?:please\s+)?(?:can you\s+)?remind me\b/i.test(text) && tail[1].split(/\s+/).length >= 2) text = `remind me ${tail[2] ? `${tail[2]} ` : ""}to ${tail[1]}`;
  const task =
    text
      .replace(/^\s*(?:please\s+)?(?:can you\s+)?(?:remind me|set (?:me )?a reminder|add a (?:reminder|to-?do|task)|put (?:in )?a reminder|create a reminder|make a reminder|reminder|don'?t let me forget|make sure i (?:don'?t forget|remember))\s*:?\s*(?:for me\s+)?(?:(?:to|that|about|for)\b)?\s*/i, "")
      .trim() || text;
  const parsed = parseEventRequest(task, ctx.now(), tz(), 9 * 60);
  const hasWhen = !("error" in parsed) && parsed.title.toLowerCase() !== task.toLowerCase();
  const title = (hasWhen ? parsed.title : task.replace(/[.!?]+$/, "")).replace(/^to\s+/i, "");
  const dueAt = hasWhen ? parsed.startsAt : undefined;
  const shown = title.charAt(0).toUpperCase() + title.slice(1);
  addReminder(ctx, shown, dueAt, "assistant");
  // "every sunday": reminders don't repeat; say so rather than let the user believe in a weekly series.
  const repeat = /\b(every|each|weekly|daily|monthly)\b/i.test(text) ? " Reminders don't repeat: this is a single one; add the next one when it's done." : "";
  return {
    reply: `Added to your reminders: “${shown}”${dueAt ? `, due ${dayLabel(dueAt)}${"error" in parsed || parsed.allDay ? "" : ` at ${hm(dueAt)}`}` : ""}.${repeat}`,
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
  // "chase the one that's been longest": the oldest wait (rows are oldest first).
  // By person, or by what the mail was about ("follow up on the kitchen quote": "Quote for the kitchen shelves").
  const topic = w.split(/[^\p{L}]+/u).filter((x) => x.length >= 4 && !/^(?:about|with|from|that|this|their|reply|answer|email|mail)$/.test(x));
  const match = /\b(longest|oldest|first|most overdue)\b/.test(w) ? rows[0] : rows.find((r) => r.recipient.toLowerCase().includes(w) || (w.length >= 4 && r.subject.toLowerCase().includes(w))) ?? (topic.length ? rows.find((r) => topic.every((x) => r.subject.toLowerCase().includes(x.replace(/s$/, "")))) : undefined);
  if (!match) {
    return {
      reply: rows.length ? `I don't see a conversation with “${who}” waiting for an answer. These are:` : `No conversation is waiting for an answer, so there's nobody to nudge.`,
      items: rows.map((r) => ({ title: r.subject, detail: `to ${r.recipient.replace(/\s*<[^>]*>/, "")}` })),
      section: "insights",
    };
  }
  try {
    const { actionId, existing } = await proposeNudge(ctx, match.thread_id);
    const to = match.recipient.replace(/\s*<[^>]*>/, "");
    if (existing) return { reply: `A follow-up to ${to} about “${match.subject}” is already waiting for your approval in the Action Queue, so I didn't draft a second one.`, actionId, section: "actions" };
    // Autopilot: a follow-up the owner asked for by name ("nudge Tom") may go to Gmail Drafts without a click.
    const address = parseSender(match.recipient).email;
    if (address) {
      const auto = await autoRun(ctx, actionId, "typed", draftFacts(ctx, who, address, parseSender(match.recipient).name ?? null));
      if (auto.auto) return { reply: `Done for you: a follow-up to ${to} about “${match.subject}” is in your Gmail Drafts (never sent; you send it). Undo it under “Done for you” on Today.`, actionId, section: "today" };
    }
    return { reply: `Drafted a follow-up to ${to} about “${match.subject}”. Review it in the Action Queue; nothing is sent until you approve it.`, actionId, section: "actions" };
  } catch (err) {
    if (err instanceof InsightError) return { reply: err.message, section: "permissions" };
    throw err;
  }
}

/** "What should I do first today?": a short prioritised list, built from the user's own data in code (no model, nothing invented). */
export async function priorities(ctx: Ctx): Promise<SkillAnswer> {
  const items: { title: string; detail?: string }[] = [];
  const endOfToday = parseRange("today", ctx.now(), tz()).to.toISOString();
  for (const r of all<{ text: string; due_at: string | null }>(ctx.db, "SELECT text, due_at FROM reminders WHERE done_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT 3", endOfToday)) {
    items.push({ title: r.text, detail: Date.parse(r.due_at!) < ctx.now().getTime() - 3_600_000 ? "reminder, overdue" : `reminder, due ${hm(r.due_at!)}` });
  }
  for (const m of all<{ sender: string; subject: string }>(ctx.db, `SELECT sender, subject FROM messages WHERE needs_reply = 1${demoRowsFilter()} ORDER BY received_at DESC LIMIT 4`)) {
    items.push({ title: `Answer: ${m.subject}`, detail: `from ${m.sender.replace(/\s*<[^>]*>/, "")}, waiting for your reply` });
  }
  const today = await agenda(ctx, "what's on today").catch(() => null);
  for (const it of today?.items ?? []) items.push({ title: it.title, detail: it.detail ? `today, ${it.detail}` : "today" });
  const now = ctx.now().getTime();
  for (const w of all<{ recipient: string; subject: string; sent_at: string }>(ctx.db, `SELECT recipient, subject, sent_at FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at LIMIT 2`)) {
    const days = Math.floor((now - Date.parse(w.sent_at)) / 86_400_000);
    if (days >= 3) items.push({ title: `Chase ${w.recipient.replace(/\s*<[^>]*>/, "")}: ${w.subject}`, detail: `no answer for ${days} days` });
  }
  if (!items.length) return { reply: "Nothing is pressing right now: no reminders due, no mail waiting for your answer, and nothing on today's calendar." };
  const shown = items.slice(0, 8);
  return { reply: `${shown.length} thing${shown.length === 1 ? "" : "s"} to look at, in the order I'd do them:`, items: shown, section: "today" };
}

/** "What trips do I have coming up?" */
export async function trips(ctx: Ctx): Promise<SkillAnswer> {
  const note = await refreshScan(ctx, "inbox", "gmail.scan_bookings", "insights.scanned.bookings");
  const flights = upcomingFlights(ctx, tz());
  const others = all<{ kind: string; subject: string; received_at: string }>(ctx.db, `SELECT kind, subject, received_at FROM bookings WHERE kind != 'flight'${demoRowsFilter()} ORDER BY received_at DESC LIMIT 10`);
  if (!flights.length && !others.length) return { reply: `I found no trips or bookings in your mail (confirmations from the last 6 months).${note ? ` ${note}` : ""}`, section: "insights" };
  const fmtDate = (d: { y: number; m: number; d: number }) => new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return {
    reply: `${flights.length ? `Your next flight: ${flights[0].from} → ${flights[0].to} on ${fmtDate(flights[0].date)}${flights[0].time ? ` at ${flights[0].time}` : ""}. ` : ""}${flights.length} upcoming flight${flights.length === 1 ? "" : "s"}${others.length ? ` and ${others.length} other booking${others.length === 1 ? "" : "s"}` : ""}. Say “add my flights to my calendar” to add them.${note ? ` ${note}` : ""}`,
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

export const ANSWER_SYSTEM = [
  "You answer the user's question using ONLY the emails given below, which come from their own mailbox.",
  "Quote the exact facts (dates, times, amounts, references, addresses) and cite the email number like [1].",
  "If the emails don't contain the answer, say so plainly in one sentence. Do not guess. Answer in English, in at most three sentences.",
  UNTRUSTED_DATA_RULES,
].join("\n");

/** Model answers are shown as plain text, so Markdown (bold, headings, bullets, trailing notes) is turned into plain text. */
export function plainAnswer(text: string): string {
  return text
    // Internal data markers the model sometimes echoes ("<untrusted …>"): never shown to the user.
    .replace(/<\/?untrusted[^>]*>/gi, "")
    .replace(/^\s*\*\(?(?:Note|Disclaimer)[\s\S]*$/im, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .replace(/([^\n])\s+•\s+/g, "$1\n• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Every figure in an answer must be written in its sources: a sentence with a number the sources don't contain (an invented
 * "previous price of 334 EUR") is removed, and the answer says a figure was left out. Citations ([1]) and single digits are not
 * checked; "7,600", "7 600" and "7600" count as the same number. Pure.
 */
export function groundNumbers(answer: string, sources: string): string {
  const norm = (t: string) => t.replace(/(\d)[,\u202f\u00a0 ](?=\d{3}\b)/g, "$1");
  const known = new Set((norm(sources).match(/\d+(?:[.:]\d+)*/g) ?? []).flatMap((n) => [n, ...n.split(/[.:]/)]));
  // A day of the month next to a month name ("October 20", "20 Oct") is a date, checked elsewhere (the weekday rule).
  const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  const noDays = (t: string) => t.replace(new RegExp(`\\b(?:[12]?\\d|3[01])(?:st|nd|rd|th)?\\s+${MONTH}|${MONTH}\\s+(?:[12]?\\d|3[01])(?:st|nd|rd|th)?\\b`, "gi"), " ");
  const figures = (sentence: string) => (norm(noDays(sentence).replace(/\[\d+(?:\s*[,\]\[]\s*\d+)*\]/g, "")).match(/\d+(?:[.:]\d+)*/g) ?? []).filter((n) => n.replace(/\D/g, "").length >= 2);
  const unknown = (t: string) => figures(t).some((n) => !known.has(n) && !n.split(/[.:]/).every((x) => known.has(x)));
  const CITE = /\[\d+(?:\s*[,\]\[]\s*\d+)*\]/g;
  // A sentence whose main clause holds no unknown figure keeps that clause ("The Pacific is the largest ocean, covering
  // 165 million km²" -> "The Pacific is the largest ocean."): dropping it whole left answers starting with "It is also…".
  const salvage = (sentence: string): string | null => {
    const end = sentence.match(/[.!?]\s*$/)?.[0]?.trim() ?? "";
    const body = sentence.slice(0, sentence.length - (sentence.match(/[.!?]\s*$/)?.[0].length ?? 0)).replace(/\s*\([^()]*\)/g, (m) => (unknown(m) ? "" : m));
    const clauses = body.split(/,\s+|;\s+|\s+[—–]\s+/);
    // The main clause must stand alone: not a lead-in ("On 12 March, the price rose to 334 EUR" goes whole).
    if (unknown(clauses[0]) || clauses[0].trim().split(/\s+/).length < 4 || /^(?:on|in|at|by|for|from|since|after|before|during|as of|according to|until|with|without|if|when|while|although|because)\b/i.test(clauses[0].trim())) return null;
    const kept = clauses.filter((c) => !unknown(c));
    const cites = [...new Set(clauses.filter((c) => unknown(c)).flatMap((c) => c.match(CITE) ?? []))].filter((c) => !kept.join(" ").includes(c));
    return `${kept.join(", ").trim()}${cites.length ? ` ${cites.join("")}` : ""}${end || "."}`;
  };
  const parts = answer.split(/(?<=[.!?])\s+|\n+/);
  let dropped = 0;
  const kept = parts.flatMap((p) => {
    if (!unknown(p)) return [p];
    dropped++;
    const part = salvage(p);
    return part ? [part] : [];
  });
  if (!dropped) return answer;
  // Nothing left but citations or punctuation ("[1]"): say so, never show an empty answer.
  if (!kept.join(" ").replace(/\[\d+(?:\s*[,\]\[]\s*\d+)*\]/g, "").replace(/[\s.,;:!?•*-]/g, "")) return "I couldn't confirm the details from the sources: they're listed below.";
  return `${kept.join(" ").replace(/\s+•/g, "\n•").trim()} (I left out a figure I couldn't find in the sources.)`;
}

export const WEB_SYSTEM = [

  "You answer the user's question using ONLY the web search results and pages given below.",
  "Give the answer first, with the key facts (names, dates, numbers), and cite sources like [1]. Prefer the most recent and most official sources; say when sources disagree.",
  "State ONLY facts written in the sources: no background, history, records or comparisons from your own knowledge (they are often wrong). Two sentences are usually enough; end after the answer.",
  "If the sources don't answer the question, say so plainly in one sentence. Do not guess. Answer in English, in at most four sentences of plain text (no Markdown, no notes).",
  UNTRUSTED_DATA_RULES,
].join("\n");

/**
 * "Who won the final?", "opening hours of the Picasso museum": the user's own SearXNG finds pages, the top
 * three are read (public https pages only), and the local model answers with numbered sources.
 */
export async function webAnswer(ctx: Ctx, question: string, query: string, progress: (s: string) => void, llm: LlmProvider = workLlm(ctx, "background")): Promise<SkillAnswer> {
  const found = await webSources(ctx, query, progress);
  if (!("results" in found)) return found;
  progress("Writing the answer…");
  const today = ctx.now().toISOString().slice(0, 10);
  const out = await llm.generate(WEB_SYSTEM, webPrompt(question, query, today, found), { maxTokens: 260, timeoutMs: 1_200_000 });
  const sourceText = `${today} ${question} ${found.results.map((r) => `${r.title} ${r.snippet} ${found.pages.get(r.n) ?? ""}`).join(" ")}`;
  return { reply: groundNumbers(plainAnswer(out.text), sourceText), items: webItems(found.results) };
}

/**
 * What the model reads for a web answer: the top results' snippets and, from each page read, only the passages
 * that share words with the question (about 700 characters a page). The first 2,500 characters of every page
 * made the model read ~2,500 tokens: 8-10 minutes on a laptop CPU.
 */
export function webPrompt(question: string, query: string, today: string, found: { results: WebResult[]; pages: Map<number, string> }, mode: "passages" | "lead" = "passages"): string {
  const results = mode === "lead" ? found.results : found.results.slice(0, WEB_SNIPPETS);
  const page = (n: number) => {
    const text = found.pages.get(n);
    if (!text) return "";
    return `\nPage text: ${mode === "lead" ? text.slice(0, 2500) : relevantPassages(text, `${question} ${query}`, WEB_PASSAGE_CHARS)}`;
  };
  const sources = results.map((r) => fenceUntrusted(`web result [${r.n}] ${new URL(r.url).hostname}`, `Title: ${r.title}\nSnippet: ${r.snippet}${page(r.n)}`)).join("\n\n");
  return `Today is ${today}.\nQuestion: ${question}\n\n${sources}`;
}
const WEB_SNIPPETS = 6;
const WEB_PASSAGE_CHARS = 700;

/** Reads the top matches of a Gmail search (skipping AI-directed text) for the local model. */
export async function readMatches(ctx: Ctx, query: string, max: number, progress: (s: string) => void, allowBulk = false) {
  const rows = await callTool(ctx, "inbox", "gmail.search", { query, max: 8 }, new RunBudget(1, 60_000));
  const read: { n: number; sender: string; subject: string; date: string; text: string }[] & { skipped: { bulk: number; flagged: number } } = Object.assign([], { skipped: { bulk: 0, flagged: 0 } });
  const usable = rows.filter((x) => allowBulk || !x.bulk || /booking|reserv|ticket|invoice|factura|order|confirm/i.test(x.subject));
  read.skipped.bulk = rows.length - usable.length;
  for (const r of usable.slice(0, max)) {
    progress(`Reading “${r.subject.slice(0, 60)}”…`);
    const m = await callTool(ctx, "inbox", "gmail.read_by_id", { gmailId: r.id }, new RunBudget(1, 60_000));
    if (isAiDirected(injectionFlags(`${m.subject}\n${m.text}`))) {
      read.skipped.flagged++;
      continue;
    }
    // ~2,500 characters each: enough for the facts, which are near the top; the model's limits are generous.
    read.push({ n: read.length + 1, sender: r.sender, subject: r.subject, date: r.date, text: m.text.slice(0, 2500) });
  }
  return read;
}

/** Why matching mail was left out, for the "I found no email" replies: never say nothing exists when something was skipped on purpose. */
export function skippedNote(read: { skipped: { bulk: number; flagged: number } }): string {
  const parts: string[] = [];
  if (read.skipped.flagged) parts.push(`${read.skipped.flagged} matching email${read.skipped.flagged > 1 ? "s were" : " was"} not read because ${read.skipped.flagged > 1 ? "they contain" : "it contains"} instructions aimed at an AI`);
  if (read.skipped.bulk) parts.push(`${read.skipped.bulk} newsletter${read.skipped.bulk > 1 ? "s or promotions were" : " or promotion was"} left out`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

// Emails arrive in several languages while requests are in English: widen the main words of a search
// with their French, Spanish and Catalan forms (Gmail ignores accents).
const TRANSLATIONS: [RegExp, string[]][] = [
  [/^(bills?|payments?|charges?)$/, ["bill", "invoice", "payment", "renewal", "renews", "due", "factura", "facture"]],
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
/** Words that never help find a mail: the request's wrapper ("find the email and tell me what…"), not its subject. */
const SEARCH_FILLER =
  /^(?:from|my|mine|the|a|an|and|or|not|then|of|for|about|to|in|into|on|at|with|by|up|out|is|are|was|were|be|been|it|its|it's|this|that|these|those|there|here|i|i'm|i've|me|you|your|we|us|what|what's|whats|when|when's|where|where's|who|who's|whom|which|why|how|how's|did|do|does|done|have|has|had|can|could|would|should|will|please|just|any|anything|some|something|all|much|many|email|emails|e-mail|mail|mails|inbox|message|messages|thread|check|find|look|search|show|tell|give|let|know|see|read|get|got|send|sent|say|said|says|add|put|calendar|agenda|cost|costs|price|amount|date|dates|time|times|details?|info|information|latest|recent|soon|coming|come|due|guy|guys|man|woman|person|people|someone|somebody|thing|things|stuff|lady|remind|reminder|set|before|after|renews?|expires?|appointment)$/i;

/** The words of a request that could find its mail ("what's in the book club email" -> "book club"). */
export function searchWords(text: string) {
  return text.split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length > 1 && !SEARCH_FILLER.test(w)).slice(0, 6).join(" ");
}

export const EVENT_SYSTEM = [
  "The user wants an event in their calendar. From the sources below (their emails, or web pages), find the event they ask about (one they registered for, booked, bought tickets for or were invited to, or the public event they name) and give:",
  "found: true only if a source states the DATE the event takes place (not the date an email was sent or a registration was made).",
  "source: the number of the source that gives the date.",
  "title: a short calendar title in English with the event's own name (e.g. 'Barcelona Marathon', 'Coldplay concert', 'Dentist').",
  "date: the day of the event as YYYY-MM-DD. start and end: HH:MM in 24-hour time if the source gives them, else empty. location: the place if given, else empty.",
  "Use only what the sources say; never guess a date or a time. The sources may be in any language.",
  UNTRUSTED_DATA_RULES,
  "Answer with JSON only.",
].join("\n");
export const EVENT_SCHEMA = {
  type: "object",
  properties: { found: { type: "boolean" }, source: { type: "integer" }, title: { type: "string" }, date: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" } },
  required: ["found", "source", "title", "date", "start", "end", "location"],
};
export const FoundEvent = z.object({
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
  let date = realDay(f.date);
  // The model found no date, but an email names one weekday ("next Tuesday") and maybe a window ("between 9 and 12"): use them.
  if (!f.found || !date) {
    // Only a mail about the event asked for: it shares a main word with the request ("boiler" for "the boiler inspection").
    const asked = searchWords(text).toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
    const mail = docs.find((d) => /^Date sent: \d{4}-\d{2}-\d{2}/m.test(d.body) && asked.some((w) => `${d.title} ${d.body}`.toLowerCase().includes(w)) && weekdayAfter(d.body, d.body.match(/^Date sent: (\d{4}-\d{2}-\d{2})/m)![1]));
    if (mail) {
      const sentOn = mail.body.match(/^Date sent: (\d{4}-\d{2}-\d{2})/m)![1];
      const window = mail.body.match(/\b(?:between|from)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:and|to|-|–)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
      const hh = (h: string, ap?: string) => String(ap?.toLowerCase() === "pm" && +h < 12 ? +h + 12 : !ap && +h < 8 ? +h + 12 : +h).padStart(2, "0");
      f.found = true;
      f.source = mail.n;
      f.date = weekdayAfter(mail.body, sentOn)!;
      f.title = f.title || mail.title.replace(/\b(?:next|this|on)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, "").trim();
      const single = window ? null : mail.body.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b|\b(\d{1,2})[:h](\d{2})\b/i);
      f.start = window ? `${hh(window[1], window[3] ?? window[6])}:${window[2] ?? "00"}` : single ? `${single[1] ? String(single[3].toLowerCase() === "pm" && +single[1] < 12 ? +single[1] + 12 : +single[1]).padStart(2, "0") : single[4].padStart(2, "0")}:${single[2] ?? single[5] ?? "00"}` : "";
      f.end = window ? `${hh(window[4], window[6])}:${window[5] ?? "00"}` : "";
      date = realDay(f.date);
    }
  }
  if (!f.found || !date) return { reply: "I found sources that seem related, but none of them gives the date of the event, so I didn't add anything. They're listed below.", items };
  const src = docs.find((d) => d.n === f.source) ?? docs[0];
  // The email says "next Tuesday" and the model's date is a Sunday: the weekday in the email wins.
  const sent = src.body.match(/^Date sent: (\d{4}-\d{2}-\d{2})/m)?.[1];
  if (sent) date = realDay(correctWeekdayDate(ymdOf(date), src.body, sent)) ?? date;
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
export async function findEventInEmail(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm: LlmProvider = workLlm(ctx, "background")): Promise<EventFromEmail> {
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
  const q = widenQuery((query.replace(/[\r\n]+/g, " ").trim() || searchWords(text)).slice(0, 250));
  progress("Searching your mail…");
  let read;
  try {
    read = await readMatches(ctx, q, 4, progress);
    // "the hike with maria": the model's words as a whole match nothing; the main ones do.
    // Two words at least: one word alone ("yoga") can find another event, and a wrong date is worse than none.
    for (const loose of read.length ? [] : looserQueries(query.trim() || searchWords(text)).filter((q) => q.includes(" "))) {
      read = await readMatches(ctx, widenQuery(loose), 4, progress);
      if (read.length) break;
    }
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail for that. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  if (!read.length) return { reply: `I found no email matching “${query || searchWords(text)}”${skippedNote(read)}. Try naming the event or who it's from (e.g. “add the marathon from RunReg to my calendar”).` };
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
      // The whole readable text (up to 12,000 characters): each caller keeps what it needs.
      if (!isAiDirected(injectionFlags(text))) pages.set(r.n, text);
    } catch {
      // Unreadable page (blocked, not https, too slow): its snippet still counts.
    }
  }
  return { results, pages };
}

const webItems = (results: WebResult[]) => results.slice(0, 5).map((r) => ({ title: `[${r.n}] ${r.title}`, detail: new URL(r.url).hostname, href: r.url }));

/** "When is the Barcelona marathon 2027? Add it to my calendar": the event from public web pages. */
export async function findEventOnWeb(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm: LlmProvider = workLlm(ctx, "background"), nextYear = false): Promise<EventFromEmail> {
  const first = await findEventOnWebOnce(ctx, text, nextYear ? `${query} ${ctx.now().getUTCFullYear() + 1}` : query, progress, llm);
  // The edition found is already over (this year's race): the user means the next one.
  if (!nextYear && "reply" in first && /is already over, so I didn't add it/.test(first.reply)) {
    progress("That one is over: looking for the next edition…");
    const next = await findEventOnWeb(ctx, text, query, progress, llm, true);
    if ("prepared" in next) return next;
  }
  return first;
}

async function findEventOnWebOnce(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm: LlmProvider): Promise<EventFromEmail> {
  const found = await webSources(ctx, query, progress);
  if (!("results" in found)) return found;
  const docs = found.results.map((r) => ({
    n: r.n,
    label: `web result [${r.n}] ${new URL(r.url).hostname}`,
    body: `Title: ${r.title}\nSnippet: ${r.snippet}${found.pages.has(r.n) ? `\nPage text: ${found.pages.get(r.n)!.slice(0, 2500)}` : ""}`,
    cite: `${r.title} (${new URL(r.url).hostname})`,
    title: r.title,
  }));
  return extractEvent(ctx, text, docs, webItems(found.results), llm, progress);
}

/** "When is my hotel check-in in Lisbon?": find the emails, read them, answer with sources. */
export async function emailQuestion(ctx: Ctx, question: string, query: string, progress: (s: string) => void, llm: LlmProvider = workLlm(ctx, "background")): Promise<SkillAnswer> {
  query = query.replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
  progress("Searching your mail…");
  let read;
  try {
    read = await readMatches(ctx, widenQuery(query), 3, progress);
    // Nothing but newsletters matched and the user asked about it by name ("the weekly recipes email"): read it (the injection check still applies).
    if (!read.length && read.skipped.bulk) read = await readMatches(ctx, widenQuery(query), 3, progress, true);
    // The model's query had words the mail doesn't use ("car insurance renewal cost AND date"): retry with the main words only.
    for (const loose of read.length ? [] : looserQueries(query)) {
      read = await readMatches(ctx, widenQuery(loose), 3, progress);
      if (read.length) {
        query = loose;
        break;
      }
    }
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail for that. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  if (!read.length) {
    // "Has Priya answered?", "when did I write to priya": a wait the app already tracks answers it.
    const waits = all<{ recipient: string; subject: string; sent_at: string }>(ctx.db, `SELECT recipient, subject, sent_at FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at`);
    const named = query.match(/from:\(?"?([\p{L}'-]+)/u)?.[1]?.toLowerCase();
    const wait = named
      ? waits.find((w) => w.recipient.toLowerCase().includes(named))
      : waits.find((w) => {
          const first = w.recipient.replace(/\s*<[^>]*>/, "").split(/\s+/)[0];
          return first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question);
        });
    const who = named ?? wait?.recipient.replace(/\s*<[^>]*>/, "").split(/\s+/)[0].toLowerCase();
    if (wait) {
      const days = Math.floor((ctx.now().getTime() - Date.parse(wait.sent_at)) / 86_400_000);
      return { reply: `Not yet: you're still waiting for ${wait.recipient.replace(/\s*<[^>]*>/, "")} to answer “${wait.subject}” (you wrote ${days} day${days === 1 ? "" : "s"} ago). Say “nudge ${who}” to draft a follow-up.` };
    }
    return { reply: `I found no email matching “${query}”${skippedNote(read)}, so I can't answer that from your mail.` };
  }
  progress("Writing the answer…");
  const out = await llm.generate(ANSWER_SYSTEM, `Question: ${question}\n\n${read.map((r) => fenceUntrusted(`email [${r.n}] from ${r.sender}`, `Subject: ${r.subject}\nDate: ${r.date.slice(0, 10)}\n\n${r.text}`)).join("\n\n")}`, { maxTokens: 200, timeoutMs: 1_200_000 });
  return {
    reply: groundNumbers(plainAnswer(out.text), `${ctx.now().toISOString().slice(0, 10)} ${question} ${read.map((r) => `${r.subject} ${r.date.slice(0, 10)} ${r.text}`).join(" ")}`),
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
export async function meetingPrep(ctx: Ctx, text: string, who: string, progress: (s: string) => void, llm: LlmProvider = workLlm(ctx, "background")): Promise<SkillAnswer> {
  progress("Looking at your calendar…");
  const w = who.toLowerCase();
  const range = parseRange(/\b(today|tomorrow|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2} \w+)\b/i.test(text) ? text : "the next 14 days", ctx.now(), tz());
  const upcoming = await agenda(ctx, text).catch(() => null);
  const events = (upcoming?.items ?? []).filter((e) => e.title.toLowerCase().includes(w));
  const event = events[0] ?? null;
  let read: Awaited<ReturnType<typeof readMatches>> = Object.assign([], { skipped: { bulk: 0, flagged: 0 } });
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
  const out = await llm.generate(PREP_SYSTEM, `Today is ${localToday(ctx.now(), tz()).y}-${String(localToday(ctx.now(), tz()).m).padStart(2, "0")}-${String(localToday(ctx.now(), tz()).d).padStart(2, "0")}. The user asked: ${text}\nMeeting with or about: ${who}\n\n${material}`, { maxTokens: 260, timeoutMs: 1_200_000 });
  return {
    reply: plainAnswer(out.text),
    items: [...(event ? [{ title: `📅 ${event.title}`, detail: event.detail }] : []), ...read.map((r) => ({ title: `[${r.n}] ${r.subject}`, detail: `${parseSender(r.sender).name ?? r.sender} · ${dayLabel(r.date)}` })), ...notes.map((n) => ({ title: `📝 ${n.title}` }))],
    section: "today",
  };
}

/** What the assistant can do, for an honest "not yet" answer. */
export const CAN_DO_SHORT = "Try: “what needs my attention in my email?”, “what's on tomorrow?”, “remind me to …”, “find the race in my email and add it to my calendar”, “who hasn't answered me?”, “who won …?” (web search) or “brief me”.";
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
    // A person's own mail, never a newsletter or mailing list they happen to send (a reply to those goes to everyone).
    rows = (await callTool(ctx, "inbox", "gmail.search", { query: `from:"${name}" newer_than:90d`, max: 10 }, new RunBudget(1, 60_000))).filter((r) => !r.bulk && !/\[[^\]]{2,40}\]/.test(r.subject));
    if (!rows.length) rows = (await callTool(ctx, "inbox", "gmail.search", { query: `"${name}" newer_than:90d -in:sent`, max: 10 }, new RunBudget(1, 60_000))).filter((r) => !r.bulk && !/\[[^\]]{2,40}\]/.test(r.subject));
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail to find that email. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  const msg = rows[0];
  // No mail from them, but the user is waiting on their answer ("can you write to priya"): that is a follow-up.
  const waitedOn = (n: string) => n.length >= 3 && all<{ recipient: string }>(ctx.db, `SELECT recipient FROM waiting_on WHERE 1 = 1${demoRowsFilter()}`).some((w) => new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(w.recipient));
  if (!msg && waitedOn(name)) return nudge(ctx, name);
  if (!msg) return { reply: `I couldn't find a personal email from “${who}” in the last 90 days to reply to (newsletters and mailing lists don't count). I can only reply to an email I can find: say “reply to <name> that …”.` };
  const { name: senderName, email } = parseSender(msg.sender);
  if (!email) return { reply: "I couldn't read that sender's address." };
  progress(`Reading “${msg.subject}” and writing the reply…`);
  const read = await callTool(ctx, "inbox", "gmail.read_by_id", { gmailId: msg.id }, new RunBudget(1, 60_000));
  // An email that talks to an AI is not shown to the model: the reply is written from your words only.
  const aiDirected = isAiDirected(injectionFlags(`${msg.subject}\n${read.text}`));
  const lang = detectLanguage(read.text);
  const written = await writeReply(draftLlmFor(ctx, lang, workLlm(ctx, "background")), msg.sender, msg.subject, aiDirected ? "" : read.text, senderName, aboutMePrompt(ctx), lang, message);
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
    // Autopilot: only when the owner said what to answer ("reply to Ana that Thursday works"); a reply the model writes from
    // the other person's mail alone ("what should I reply to the landlord") counts as coming from that mail, so it waits.
    const auto = message.trim() && !aiDirected ? await autoRun(ctx, out.actionId, "typed", draftFacts(ctx, `${who} ${message}`, email, senderName ?? null)) : { auto: false as const, why: "" };
    if (auto.auto) {
      return { reply: `Done for you: a reply to ${senderName ?? email} about “${msg.subject}” is in your Gmail Drafts (never sent; you send it). Undo it under “Done for you” on Today.`, items: [{ title: subject, detail: written.reply }], actionId: out.actionId, section: "today" };
    }
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
/** `question`: the user's words, answered; `query`: the words searched (the router's, often shorter). */
export async function notesAnswer(ctx: Ctx, query: string, progress: (s: string) => void, question?: string): Promise<SkillAnswer> {
  if (!check(ctx, "knowledge", "demo-notes", "read")) return { reply: "The Knowledge agent has no read access to your notes. Grant it in Connections & Permissions.", section: "permissions" };
  const provider = nanoModelInstalled() && knowledgeStats(ctx).localVectors > 0 ? "local-semantic" : "lexical";
  progress("Searching your notes…");
  const res = await retrieve(ctx, { query, provider, k: 4, answer: true, question: question && question !== query ? question.slice(0, 500) : undefined }, workLlm(ctx, "background"), "chief_of_staff");
  if (!res.passages.length) return { reply: `I found nothing about “${query}” in your notes.`, section: "knowledge" };
  return {
    reply: res.answer?.text ? groundNumbers(plainAnswer(res.answer.text), `${query} ${res.passages.map((p) => `${p.title} ${p.text}`).join(" ")}`) : `Top notes for “${query}”:`,
    items: res.passages.map((p) => ({ title: p.title, detail: `${p.text.slice(0, 160)}${p.text.length > 160 ? "…" : ""}${p.flags.length ? " ⚠ contains instruction-like text (treated as data)" : ""}` })),
    section: "tech",
  };
}


/** Does a note clearly cover this request ("how much is left of the kitchen budget")? Used before answering "I can't do that". */
export async function notesLikely(ctx: Ctx, text: string, minWords = 1): Promise<boolean> {
  if (!check(ctx, "knowledge", "demo-notes", "read")) return false;
  const stop = new Set(["much", "left", "with", "that", "this", "what", "have", "from", "about", "there", "would", "could", "should", "please", "tell", "show", "give", "need", "want", "know", "when", "which", "does", "into", "over", "your", "mine", "anything", "something", "today", "tomorrow", "week", "time", "make", "sure", "remind", "reminder", "email", "mail", "calendar", "some", "much", "many", "they", "them", "were", "will", "just", "like"]);
  const words = (text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !stop.has(w)).map((w) => w.replace(/s$/, ""));
  if (!words.length) return false;
  const res = await retrieve(ctx, { query: text, provider: "lexical", k: 2 }, undefined, "chief_of_staff");
  return res.passages.some((p) => new Set(words.filter((w) => p.title.toLowerCase().includes(w))).size >= minWords);
}

/** "What's Priya's email?": addresses from the user's own mail (tracked waits and synced headers). Nothing is guessed. */
export function contactLookup(ctx: Ctx, who: string): SkillAnswer {
  const w = who.toLowerCase().trim();
  const seen = new Map<string, string>();
  const rows = [
    ...all<{ addr: string }>(ctx.db, `SELECT recipient AS addr FROM waiting_on WHERE 1 = 1${demoRowsFilter()}`),
    ...all<{ addr: string }>(ctx.db, `SELECT sender AS addr FROM messages WHERE 1 = 1${demoRowsFilter()} ORDER BY received_at DESC LIMIT 500`),
  ];
  for (const { addr } of rows) {
    const { name, email } = parseSender(addr);
    const full = addr.replace(/\s*<[^>]*>/, "").replace(/"/g, "").trim();
    if (email && new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(`${full} ${email}`)) seen.set(email.toLowerCase(), name ? full : email);
  }
  if (!seen.size) return { reply: `I don't have an email address for “${who}” in your recent mail.` };
  const list = [...seen].map(([email, label]) => (label === email ? email : `${label} — ${email}`));
  return { reply: list.length === 1 ? `${list[0]} (from your mail).` : `I found ${list.length} addresses for “${who}”:`, items: list.length > 1 ? list.map((l) => ({ title: l })) : undefined };
}

/** "car insurance renewal cost AND date" -> "car insurance": search operators, alternatives and question words dropped, at most the first two main words. Null if nothing is left. */
export function looserQuery(query: string): string | null {
  return looserQueries(query)[0] ?? null;
}

/** Looser and looser versions of a search that found nothing: the first two main words, then the first alone. */
export function looserQueries(query: string): string[] {
  if (/\b(?:from|to|subject|label|in|after|before|newer_than|older_than):/i.test(query)) return []; // a precise search: leave it
  const first = query.split(/\s+OR\s+/i)[0];
  // "the landlord's boiler visit": "landlord", not "landlord's" (mail says "your landlord").
  const words = first.replace(/[()"?.,!]/g, " ").split(/\s+/).map((w) => w.replace(/['’]s$/i, "")).filter((w) => w.length > 1 && !SEARCH_FILLER.test(w));
  const longest = [...words].sort((a, b) => b.length - a.length)[0] ?? "";
  return [...new Set([words.slice(0, 3).join(" "), words.slice(0, 2).join(" "), words[0] ?? "", longest])].filter((q) => q && q !== query);
}

/**
 * Last resort, when a request can't be placed with confidence: one short question built from the user's own words and the
 * people the app knows, instead of a guess or a generic "I can't". Used rarely on purpose (tests count every ask as a miss).
 */
export function clarify(ctx: Ctx, text: string): string {
  const known = new Map<string, string>();
  const rows = [
    ...all<{ addr: string }>(ctx.db, `SELECT recipient AS addr FROM waiting_on WHERE 1 = 1${demoRowsFilter()}`),
    ...all<{ addr: string }>(ctx.db, `SELECT sender AS addr FROM messages WHERE 1 = 1${demoRowsFilter()} ORDER BY received_at DESC LIMIT 300`),
  ];
  for (const { addr } of rows) {
    const first = parseSender(addr).name?.split(/\s+/)[0];
    if (first && first.length > 2) known.set(first.toLowerCase(), first);
  }
  const person = (text.match(/\p{L}[\p{L}'-]+/gu) ?? []).map((w) => known.get(w.toLowerCase())).find(Boolean);
  const when = text.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week(?:end)?)\b/i)?.[1];
  const options = person
    ? [`reply to ${person} that …`, `find the email from ${person}`, `did ${person} answer?`]
    : when
      ? [`what's on ${when}?`, `remind me ${when} to …`, `add event: … ${when} at …`]
      : ["what needs my attention in my email?", "what's on tomorrow?", "remind me to …"];
  return `I'm not sure what you'd like me to do with “${text.trim().slice(0, 80)}”. Could you say it a bit more fully, for example “${options.join("”, “")}”?`;
}

/** "List my reminders": the open ones, soonest first. */
export function remindersList(ctx: Ctx): SkillAnswer {
  const open = listReminders(ctx).filter((r) => !r.done_at);
  if (!open.length) return { reply: "You have no open reminders.", section: "today" };
  return { reply: `${open.length} open reminder${open.length === 1 ? "" : "s"}:`, items: open.slice(0, 15).map((r) => ({ title: r.text, detail: r.due_at ? `due ${dayLabel(r.due_at)} at ${hm(r.due_at)}` : "no date" })), section: "today" };
}
