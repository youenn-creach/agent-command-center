import { z } from "zod";
import { all, type Ctx } from "../db";
import { logActivity } from "../activity";
import { listJobs, startRunNow, type WorkflowRegistry } from "../scheduler/scheduler";
import { createHash } from "node:crypto";
import { knowledgeStats, retrieve } from "../retrieval/knowledge";
import { listWebhooks } from "../connectors/webhooks";
import { callTool } from "../tools/registry";
import { RunBudget } from "../tools/budget";
import { parseSender } from "./chiefOfStaff";
import { nanoModelInstalled } from "../retrieval/embeddings";
import type { EventRow } from "../tools/registry";
import { config } from "../config";
import { parseEventRequest, type PreparedEvent } from "./eventParse";
import { addFact, listFacts } from "../memory";
import { findFreeSlots, formatSlots, workingHoursFromFacts } from "./slots";
import { recordRequest } from "../requests";
import { appMode, demoRowsFilter } from "../mode";
import { check } from "../policy/engine";
import { getAction } from "../approvals";
import { APP_CALENDAR_NAME } from "../connectors/google";
import { calendarMode } from "../calendarMode";
import { alreadyInCalendar, flightEvent, flightKey, upcomingFlights } from "./flights";
import { deadlinesToReminders, nudgeAll, prepDay, reminderFromEmail, tripWeather } from "./chains";
import { agenda, CAN_DO, draftReplyFree, emailQuestion, findEventInEmail, findEventOnWeb, webAnswer, emailSearch, meetingPrep, notesAnswer, nudge, quickRoute, reminderFromText, routeRequest, subscriptions, trips, waitingOn, weatherAnswer, type Route, type SkillAnswer } from "./assistant";
import { reviewInbox } from "./inboxReview";
import type { LlmProvider } from "../llm";
import { finishRequest, setRequestProgress } from "../requests";
import { notify } from "../notify";
import { getSetting, one } from "../db";

/**
 * "Ask your Chief of Staff": a typed request is mapped by plain rules (no LLM) to ONE of a few
 * allowlisted intents. It can start existing workflows and answer read-only questions about the
 * dashboard. It cannot send, approve, delete or change permissions — those requests get an
 * explicit refusal pointing to the screen where the user does it themselves.
 */

export const CommandSchema = z.object({ text: z.string().trim().min(1).max(300) });

export type Intent =
  | "inbox_review" | "email_search" | "email_question" | "event_from_email" | "reminder_from_email" | "deadlines_to_reminders" | "trip_weather" | "prep_day" | "nudge_all" | "event_from_web" | "reply_and_add" | "meeting_prep" | "weather" | "agenda" | "reminder" | "nudge" | "waiting_on" | "trips" | "subscriptions" | "notes" | "web_search" | "unsupported"
  | "slots" | "remember" | "event" | "flights" | "briefing" | "weekly" | "followups" | "search" | "schedule" | "pending" | "today" | "automation" | "draft" | "refused" | "help";

export interface CommandResult {
  intent: Intent;
  reply: string;
  items?: { title: string; detail?: string }[];
  /** What the request started, so the request board can follow its status. */
  ref?: { actionId?: string; runId?: string };
  /** A prepared calendar event: added by the app after approval, or by the user via Google's page. */
  event?: PreparedEvent;
  /** When the app will create the event: what the one-click "Approve and add" needs. */
  approval?: { actionId: string; hash: string; calendar: string };
  /** Several prepared events at once (flights from booking emails), each with its own approval when the app adds them. */
  events?: { event: PreparedEvent; approval?: { actionId: string; hash: string; calendar: string } }[];
  section?: "today" | "actions" | "schedules" | "tech" | "permissions" | "knowledge" | "insights";
  /** Work that continues after the reply (the local model reading or writing): its answer lands on the request board. */
  background?: (progress: (s: string) => void) => Promise<SkillAnswer>;
  /** Asked for something the assistant can't do (yet): shown as such on the request board. */
  unsupported?: boolean;
  /** How the request was understood: by the local model (and which one) or by an exact command. */
  understood?: string;
}

const CALENDAR_WORD = /\b(calendar|calendrier|calendario|calendari|agenda)\b/i;
// Things only the user may do, by hand: a request that STARTS with one of these verbs (a question that
// merely mentions paying or deleting is fine), or anything about credentials. Sending is not here:
// the assistant only ever drafts, and drafts wait for approval.
const REFUSE = /^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:approve|authori[sz]e|grant|give\b.{0,40}\baccess|change (?:the |my )?permissions?|delete|remove|disconnect|pay|transfer|wire)\b|\b(?:password|passcode|api key|token)s?\b/i;

export function classify(text: string): { intent: Intent; query?: string; target?: string } {
  const t = text.trim();
  if (REFUSE.test(t)) return { intent: "refused" };
  // "draft reply to <who>: <text>" only proposes a Gmail draft; nothing reaches Gmail until approved.
  const draft = t.match(/^draft (?:a )?reply to\s+(.{2,80}?)\s*:\s*([\s\S]{1,4000})$/i);
  if (draft) return { intent: "draft", target: draft[1].trim(), query: draft[2].trim() };
  // "add my flights to my calendar", "mets mes vols dans mon agenda": flights from booking emails.
  if (/\b(flights?|plane tickets?|vols?|vuelos?|vols d'avion|billets? d'avion|bitllets? d'avi[oó])\b/i.test(t) && CALENDAR_WORD.test(t)) return { intent: "flights" };
  // "add event: dentist tuesday 3pm", "add lunch with Sam to my calendar", "calendar: …"
  const event =
    t.match(/^(?:add|create|new|book|put)\s+(?:an?\s+)?(?:event|appointment|meeting)\s*:?\s*(.{2,200})$/i) ??
    t.match(/^(?:add|put)\s+(.{2,200}?)\s+(?:to|in|into|on(?:to)?)\s+(?:my\s+)?calendar$/i) ??
    t.match(/^(?:add to (?:my )?calendar|calendar|event)\s*:\s*(.{2,200})$/i) ??
    // French: "ajoute un rdv : dentiste mardi 15h", "rdv : …", "événement : …"
    t.match(/^(?:ajoute[rz]?|cr[ée]e[rz]?|nouvel?(?:le)?)\s+(?:un\s+|une\s+)?(?:[ée]v[ée]nement|rdv|rendez-vous)\s*:?\s*(.{2,200})$/i) ??
    t.match(/^(?:rdv|rendez-vous|[ée]v[ée]nement|agenda)\s*:\s*(.{2,200})$/i);
  // "add the dentist appointment from the confirmation email to my calendar" is about an email: not an exact event.
  if (event && !/\b(e-?mails?|mails?|inbox|gmail|confirmation|booking|courriels?|correos?)\b/i.test(event[1])) return { intent: "event", query: event[1].trim() };
  // "remember that I prefer short replies" adds an About-me fact (the user's own words).
  const remember = t.match(/^remember(?: that)?\s*:?\s+(.{2,300})$/i);
  if (remember) return { intent: "remember", query: remember[1].trim() };
  // "propose times to Ana", "find time with Ana for 30 min": free slots, drafted as a reply.
  const slots =
    t.match(/^(?:propose|suggest|offer|send)\s+(?:some\s+|a few\s+)?(?:times?|slots?|availabilit(?:y|ies))\s+(?:to|for|with)\s+(.{2,60}?)(?:\s+for\s+(\d{1,3})\s*(min(?:ute)?s?|h(?:ours?)?))?\s*$/i) ??
    t.match(/^find (?:a |some )?(?:time|slots?) (?:with|for) (.{2,60}?)(?:\s+for\s+(\d{1,3})\s*(min(?:ute)?s?|h(?:ours?)?))?\s*$/i);
  if (slots) return { intent: "slots", target: slots[1].trim(), query: slots[2] ? String(/^h/i.test(slots[3]) ? +slots[2] * 60 : +slots[2]) : undefined };
  // "trigger <webhook name>: <text>" only ever creates a proposal for the Action Queue.
  const automation = t.match(/^(?:trigger|run|zap|use)\s+(.{2,60}?)\s*:\s*(.{1,1000})$/i);
  if (automation) return { intent: "automation", target: automation[1].trim(), query: automation[2].trim() };
  const search = t.match(/^(?:find|search(?: for)?|look up|what did i (?:write|note) (?:about|on)|notes? (?:on|about))\s+(.+)$/i);
  if (search) return { intent: "search", query: search[1].replace(/[?.!]+$/, "") };
  if (/\bweek(ly)?\b/i.test(t) && /\b(review|recap|summary|look back|ahead)\b/i.test(t)) return { intent: "weekly" };
  if (/\b(brief(ing)?|morning (summary|update)|catch me up)\b/i.test(t)) return { intent: "briefing" };
  if (/\b(follow[- ]?ups?|draft (replies|responses|answers)|who (do i|should i) (reply|answer))\b/i.test(t)) return { intent: "followups" };
  if (/\b(schedul\w*|next runs?|jobs?|when (does|will) .* run)\b/i.test(t)) return { intent: "schedule" };
  if (/\b(pending|waiting|approvals?|action queue|to approve)\b/i.test(t)) return { intent: "pending" };
  // A request to *change* the calendar that matched nothing above is not a question about today.
  if (CALENDAR_WORD.test(t) && /\b(add|put|create|schedule|insert|book|ajoute[rz]?|mets|cr[ée]e[rz]?|a[ñn]ad[ea]|pon|afegeix|posa)\b/i.test(t)) return { intent: "help", query: "calendar" };
  if (/\b(today|agenda|calendar|meetings?|events?|tomorrow)\b/i.test(t)) return { intent: "today" };
  return { intent: "help" };
}

const HELP =
  "I can: run your briefing (“brief me”), run the weekly review, draft follow-ups, search your notes (“find Lisbon”), show what's scheduled, what's waiting for approval, today's agenda, add a calendar event (“add event: dentist tuesday 3pm at Riverside Dental”), add the flights from your booking emails (“add my flights to my calendar”), propose free times in a reply (“propose times to Ana”), remember something about you (“remember I prefer short replies”), prepare a webhook call (“trigger Todoist: buy milk”) or a Gmail reply draft (“draft reply to Ana: sounds good!”) for your approval.";

function startWorkflow(ctx: Ctx, workflow: string, label: string, workflows: WorkflowRegistry): CommandResult {
  const job = listJobs(ctx).find((j) => j.workflow === workflow);
  if (!job) return { intent: "help", reply: `There is no "${label}" schedule yet. Create one in Scheduled Agents first.`, section: "schedules" };
  const runRow = startRunNow(ctx, job.id, workflows);
  return { ref: { runId: runRow.id }, intent: "briefing", reply: `Started “${job.name}”. It runs in the background under the usual permission checks; the result appears in Today.`, section: "today" };
}

/**
 * Free slots for the next week (Google Calendar if connected, else the demo calendar), drafted as a
 * reply to the person's latest message, for approval. Without a message or a draft service, the
 * slots are just shown so the user can paste them.
 */
async function proposeSlots(ctx: Ctx, who: string, durationMin: number): Promise<CommandResult> {
  const intent = "slots" as const;
  const tz = config().timezone;
  const from = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const google = isConnected(ctx, "google-calendar");
  let events: EventRow[];
  try {
    events = google
      ? await callTool(ctx, "calendar", "gcal.list_events", { from, days: 9 }, new RunBudget(1, 5000))
      : await callTool(ctx, "calendar", "calendar.list_events", { from, days: 9 }, new RunBudget(1, 5000));
  } catch (err) {
    if ((err as { code?: string }).code === "POLICY_DENIED") return { intent, reply: "The Calendar agent needs Read on your calendar to find free time. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  const hours = workingHoursFromFacts(listFacts(ctx).map((f) => f.text)) ?? {};
  const slots = formatSlots(findFreeSlots(events, ctx.now(), tz, { durationMin: Math.min(Math.max(durationMin, 15), 240), ...hours }), tz);
  if (!slots.length) return { intent, reply: "I couldn't find a free slot in working hours over the next week." };
  const items = slots.map((s) => ({ title: s }));

  // Reply in the person's latest thread: real Gmail when drafts are connected, else the demo inbox.
  const real = isConnected(ctx, "gmail-drafts");
  const msg = all<{ id: string; sender: string; subject: string; thread_id: string | null; rfc_message_id: string | null }>(
    ctx.db,
    `SELECT id, sender, subject, thread_id, rfc_message_id FROM messages WHERE source = ? AND lower(sender) LIKE ?${demoRowsFilter()} ORDER BY received_at DESC LIMIT 1`,
    real ? "gmail" : "demo",
    `%${who.toLowerCase().replace(/[%_]/g, "")}%`,
  )[0];
  const { name, email } = msg ? parseSender(msg.sender) : { name: null, email: null };
  if (!msg || !email) return { intent, reply: `Free ${durationMin}-minute slots${google ? " (Google Calendar)" : ""}. No message from “${who}” to reply to, so copy them where you need:`, items };
  const body = `Hi${name ? ` ${name.split(/\s+/)[0]}` : ""},\n\nHere are a few times that work for me (${durationMin} min):\n${slots.map((s) => `- ${s}`).join("\n")}\n\nLet me know which suits you best.`;
  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  try {
    const out = await callTool(
      ctx,
      "follow_up",
      "actions.propose",
      {
        serviceId: real ? "gmail-drafts" : "demo-mail",
        kind: real ? "email_draft" : "email_reply",
        title: `Times for ${name ?? email}: ${msg.subject}`.slice(0, 200),
        payload: real
          ? { to: email, subject, body, ...(msg.thread_id ? { threadId: msg.thread_id } : {}), ...(msg.rfc_message_id ? { inReplyTo: msg.rfc_message_id } : {}) }
          : { to: email, subject, body },
        idempotencyKey: `slots:${msg.id}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}:${minuteStamp(ctx)}`,
      },
      new RunBudget(1, 5000),
    );
    return { intent, ref: { actionId: out.actionId }, reply: `Drafted a reply to ${name ?? email} with these times. Review it in the Action Queue${real ? "; once approved it lands in your Gmail Drafts" : ""}.`, items, section: "actions" };
  } catch (err) {
    if ((err as { code?: string }).code === "POLICY_DENIED") return { intent, reply: "Here are your free slots. The Follow-up agent isn't allowed to draft the reply, so copy them:", items, section: "permissions" };
    throw err;
  }
}

/**
 * Keys of user-typed commands end in the current minute: a double click is still one proposal, but
 * asking again later (after dismissing, or a failure) makes a fresh one instead of returning the
 * dead proposal. Automated sweeps keep their stable keys on purpose, so dismissed drafts stay dismissed.
 */
function minuteStamp(ctx: Ctx) {
  return ctx.now().toISOString().slice(0, 16);
}

const BOOKINGS_FRESH_MS = 6 * 3_600_000;

/**
 * "Add my flights to my calendar": flights from the booking confirmations found in your mail (subject
 * lines only), as events for you to add. Refreshes the booking scan first when it is older than 6 hours
 * (as the Inbox agent, permission-checked). Skips past flights and those already in your calendar.
 */
async function addFlights(ctx: Ctx): Promise<CommandResult> {
  const intent = "flights" as const;
  const tz = config().timezone;
  const notes: string[] = [];
  const scanned = getSetting(ctx.db, "insights.scanned.bookings");
  if (isConnected(ctx, "gmail") && (!scanned || ctx.now().getTime() - Date.parse(scanned) > BOOKINGS_FRESH_MS)) {
    try {
      await callTool(ctx, "inbox", "gmail.scan_bookings", {}, new RunBudget(1, 120_000));
    } catch (err) {
      if ((err as { code?: string }).code !== "POLICY_DENIED") throw err;
      notes.push("I couldn't re-check your mail (the Inbox agent needs Read on Gmail), so this uses the last scan.");
    }
  }
  const legs = upcomingFlights(ctx, tz);
  const inCalendar = legs.filter((l) => alreadyInCalendar(ctx, l, tz));
  const todo = legs.filter((l) => !inCalendar.includes(l));
  if (!todo.length) {
    const none = legs.length
      ? `Your ${legs.length} upcoming flight(s) are already in your calendar.`
      : "I found no upcoming flights in your booking confirmations (I look at confirmations from the last 6 months, subject lines only).";
    return { intent, reply: [none, ...notes].join(" "), section: "today" };
  }
  if (inCalendar.length) notes.push(`Already in your calendar, so left out: ${inCalendar.map((l) => `${l.from} → ${l.to}`).join(", ")}.`);
  logActivity(ctx, { actor: "calendar", kind: "agent_run", agentId: "calendar", outcome: "info", summary: `Prepared ${todo.length} flight event(s) from booking confirmations` });
  const events: NonNullable<CommandResult["events"]> = todo.map((leg) => ({ event: flightEvent(leg, tz, ctx.now()) }));
  const timeNote = todo.some((l) => !l.time) ? " Departure times aren't in the subject lines, so they're all-day events: open the confirmation for the time." : "";

  // Where the app adds events itself (app calendar connected, Calendar agent allowed), each one is a proposal to approve.
  const target = appMode() === "demo" ? "demo-calendar" : "google-calendar-app";
  if (calendarMode(ctx) === "app" && isConnected(ctx, target)) {
    const calendar = target === "demo-calendar" ? "Demo Calendar" : APP_CALENDAR_NAME;
    try {
      for (const [i, leg] of todo.entries()) {
        const e = events[i].event;
        const base = `flight:${target}:${flightKey(leg)}`;
        // Asking again reuses a proposal still waiting; an added flight is not proposed twice.
        const prior = one<{ id: string; status: string }>(ctx.db, "SELECT id, status FROM actions WHERE idempotency_key LIKE ? ORDER BY created_at DESC LIMIT 1", `${base}%`);
        if (prior?.status === "executed") continue;
        const actionId =
          prior && (prior.status === "proposed" || prior.status === "approved")
            ? prior.id
            : (
                await callTool(
                  ctx,
                  "calendar",
                  "actions.propose",
                  {
                    serviceId: target,
                    kind: "calendar_event",
                    title: `Calendar: ${e.title}`.slice(0, 200),
                    payload: { calendar, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: true, timezone: e.timezone },
                    idempotencyKey: `${base}:${minuteStamp(ctx)}`,
                  },
                  new RunBudget(1, 5000),
                )
              ).actionId;
        const action = getAction(ctx, actionId);
        if (action.status === "proposed") events[i].approval = { actionId, hash: action.payload_hash, calendar };
      }
      const first = events.find((e) => e.approval)?.approval;
      return { intent, ref: first ? { actionId: first.actionId } : undefined, events, reply: [`${todo.length} upcoming flight(s) ready to add to your “${calendar}” calendar.${timeNote}`, ...notes].join(" "), section: "actions" };
    } catch (err) {
      if ((err as { code?: string }).code !== "POLICY_DENIED") throw err;
      notes.push("(The Calendar agent needs Write with approval on the app calendar to add them itself.)");
    }
  }
  return { intent, events, reply: [`${todo.length} upcoming flight(s) from your booking emails. Add each one to Google Calendar (nothing is saved until you click Save there) or download it.${timeNote}`, ...notes].join(" "), section: "today" };
}

/**
 * Where the app adds events itself (the app calendar, or the demo calendar in the demo), a prepared event
 * becomes a proposal to approve; otherwise `why` says what's missing and the user adds it via Google's page.
 */
async function proposeEvent(ctx: Ctx, prepared: PreparedEvent): Promise<{ approval: { actionId: string; hash: string; calendar: string } } | { why: string }> {
  const target = appMode() === "demo" ? "demo-calendar" : "google-calendar-app";
  if (!isConnected(ctx, target)) return { why: " To let the app add events itself, connect “Google Calendar: app calendar” in Connections & Permissions." };
  const calendar = target === "demo-calendar" ? "Demo Calendar" : APP_CALENDAR_NAME;
  try {
    const out = await callTool(
      ctx,
      "calendar",
      "actions.propose",
      {
        serviceId: target,
        kind: "calendar_event",
        title: `Calendar: ${prepared.title}`.slice(0, 200),
        payload: { calendar, title: prepared.title, startsAt: prepared.startsAt, endsAt: prepared.endsAt, allDay: prepared.allDay, timezone: prepared.timezone, ...(prepared.location ? { location: prepared.location } : {}) },
        idempotencyKey: `event:${target}:${createHash("sha256").update(`${prepared.title}|${prepared.startsAt}|${prepared.endsAt}|${prepared.location ?? ""}`).digest("hex").slice(0, 24)}:${minuteStamp(ctx)}`,
      },
      new RunBudget(1, 5000),
    );
    return { approval: { actionId: out.actionId, hash: getAction(ctx, out.actionId).payload_hash, calendar } };
  } catch (err) {
    if ((err as { code?: string }).code === "POLICY_DENIED") return { why: " (The Calendar agent needs Write with approval on the app calendar to add it itself.)" };
    throw err;
  }
}

/** "Find the race in my email and add it to my calendar": the event from the mail, proposed like any other. */
export async function eventFromEmail(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm?: LlmProvider, finder: typeof findEventInEmail = findEventInEmail): Promise<SkillAnswer> {
  const found = await finder(ctx, text, query, progress, llm);
  if (!("prepared" in found)) return found;
  const { prepared, source } = found;
  logActivity(ctx, { actor: "calendar", kind: "agent_run", agentId: "calendar", outcome: "info", summary: `Prepared a calendar event from an email: ${prepared.title.slice(0, 80)}` });
  const proposed = calendarMode(ctx) === "link" ? { why: "" } : await proposeEvent(ctx, prepared);
  if ("approval" in proposed) return { reply: `${source} Ready to add to your “${proposed.approval.calendar}” calendar: approve it in the Action Queue.`, actionId: proposed.approval.actionId, section: "actions" };
  return {
    reply: `${source} Add it with the link below (Google opens the event pre-filled; nothing is saved until you click Save there).${proposed.why}`,
    items: [{ title: `Add “${prepared.title}” to Google Calendar`, href: prepared.googleUrl }],
  };
}

function isConnected(ctx: Ctx, serviceId: string) {
  return Boolean(ctx.db.prepare("SELECT 1 FROM services WHERE id = ? AND connection_state = 'connected'").get(serviceId));
}

/** `llm` replaces the local model for understanding requests (tests pass a stub). */
export async function runCommand(ctx: Ctx, rawText: string, workflows: WorkflowRegistry, llm?: LlmProvider): Promise<CommandResult> {
  const { text } = CommandSchema.parse({ text: rawText });
  const result = await handle(ctx, text, workflows, llm);
  const id = recordRequest(ctx, text, result);
  const { background, ...reply } = result;
  if (background && id) runInBackground(ctx, id, text, background);
  return reply;
}

/** Background work: progress and the final answer go to the request board, plus a notification. */
function runInBackground(ctx: Ctx, id: string, text: string, work: NonNullable<CommandResult["background"]>) {
  void (async () => {
    try {
      const out = await work((p) => setRequestProgress(ctx, id, p));
      finishRequest(ctx, id, { ok: true, reply: out.reply, items: out.items, actionId: out.actionId });
      void notify(ctx, { key: `answer:${id}`, kind: "answer", title: "Your request is ready", summary: "The Chief of Staff finished a request.", detail: text.slice(0, 120) });
    } catch (err) {
      finishRequest(ctx, id, { ok: false, reply: `This didn't work: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}` });
    }
  })();
}

/** Commands with an exact form ("add event: …", "draft reply to Ana: …") run without the model. */
const EXACT: ReadonlySet<Intent> = new Set(["draft", "event", "remember", "slots", "automation", "flights", "refused"]);

async function handle(ctx: Ctx, text: string, workflows: WorkflowRegistry, llm?: LlmProvider): Promise<CommandResult> {
  const fast = classify(text);
  if (EXACT.has(fast.intent)) return { ...(await runIntent(ctx, text, fast, workflows)), understood: "exact command" };
  const quick = quickRoute(text);
  if (quick) return { ...(await runSkill(ctx, text, quick, workflows)), understood: "quick rule (no model needed)" };
  let route: Awaited<ReturnType<typeof routeRequest>>;
  try {
    route = await routeRequest(ctx, text, llm);
  } catch (err) {
    // No local model: fall back to keywords, and say so rather than guessing silently.
    const r = await runIntent(ctx, text, fast, workflows);
    const why = err instanceof Error ? err.message.slice(0, 120) : "unavailable";
    return { ...r, understood: "keywords (local model unavailable)", reply: fast.intent === "help" ? `I couldn't understand this one: the local model isn't available (${why}). ${HELP}` : r.reply };
  }
  return { ...(await runSkill(ctx, text, route, workflows)), understood: `${route.model} · ${Math.round(route.ms / 1000)} s` };
}

/** What a request asks to add, without the wrapper ("put … in my calendar"). */
function eventText(text: string) {
  return text
    .replace(/^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:add|put|schedule|create|book|set up|make|block)\s+(?:an?\s+)?(?:new\s+)?(?:event|appointment|meeting)?\s*:?\s*/i, "")
    .replace(/\s+(?:to|in|into|on)\s+(?:my\s+)?(?:calendar|agenda|schedule)\b(?:\s+as an event)?/i, "")
    .trim();
}

// "Find X in my email and add it to my calendar" is one request; the model sometimes picks one half.
const MAIL_WORD = /\b(e-?mails?|mail|inbox|gmail)\b/i;
const TO_CALENDAR = /\b(add|put|save|create)\b.*\b(calendar|agenda)\b/i;
const FLIGHT_WORD = /\b(flights?|planes?|plane tickets)\b/i;

async function runSkill(ctx: Ctx, text: string, route: Route, workflows: WorkflowRegistry): Promise<CommandResult> {
  // The model sometimes over-picks a chain: without its second half in the request, it's the plain skill.
  const someoneElse = text.match(/\b(?:send (?:a )?(?:reminder|nudge) to|remind|chase)\s+(?!me\b|myself\b)([A-Z][\p{L}'-]+)/u);
  if ((route.skill === "reminder_from_email" || route.skill === "reminder") && someoneElse) route = { skill: "nudge", args: { who: someoneElse[1] } };
  else if (route.skill === "reminder_from_email" && !MAIL_WORD.test(text) && !/\b(bills?|invoices?|renewal|renew|expires?|deadline|due|payment)\b/i.test(text)) route = { skill: "reminder", args: {} };
  else if (route.skill === "reply_and_add" && !TO_CALENDAR.test(text) && !/\b(calendar|agenda|schedule)\b/i.test(text)) route = { skill: "draft_reply", args: route.args };
  const s = route.skill;
  if (TO_CALENDAR.test(text) && /\b(reply|answer|tell|write back|accept|confirm)\b/i.test(text) && (s === "draft_reply" || s === "add_event") && route.args.who) {
    route = { skill: "reply_and_add", args: route.args };
  } else if (MAIL_WORD.test(text) && TO_CALENDAR.test(text) && !FLIGHT_WORD.test(text) && ["add_event", "email_question", "email_search", "add_flights", "trips"].includes(s)) {
    route = { skill: "event_from_email", args: { query: route.args.query } };
  } else if (!MAIL_WORD.test(text) && TO_CALENDAR.test(text) && s === "web_search") {
    route = { skill: "event_from_web", args: route.args };
  } else if (s === "reminder" && /\b(before (?:it'?s|they'?re) due|before the (?:deadline|due date)|(?:in|from) my (?:e-?mails?|mail|inbox))\b/i.test(text)) {
    route = { skill: "reminder_from_email", args: { query: route.args.query } };
  } else if (s === "inbox_review" && /\b(reminders?|to-?dos?)\b/i.test(text)) {
    route = { skill: "deadlines_to_reminders", args: route.args };
  } else if (s === "weather" && /\b(trip|travel|holidays?|vacation|flight)\b/i.test(text) && !route.args.query) {
    route = { skill: "trip_weather", args: {} };
  } else if (s === "meeting_prep" && /\b(meetings|all my|calls)\b/i.test(text)) {
    route = { skill: "prep_day", args: {} };
  } else if (s === "nudge" && /\b(everyone|everybody|all of them|them all|all the people)\b/i.test(text)) {
    route = { skill: "nudge_all", args: {} };
  }
  const a = route.args;
  const answer = (intent: Intent, r: SkillAnswer): CommandResult => ({ intent, reply: r.reply, items: r.items, section: r.section, ref: r.actionId ? { actionId: r.actionId } : undefined });
  const later = (intent: Intent, reply: string, work: NonNullable<CommandResult["background"]>): CommandResult => ({ intent, reply, background: work, section: "today" });
  switch (route.skill) {
    case "inbox_review": {
      const days = Math.min(Math.max(a.days ?? (/\bmonth\b/i.test(text) ? 30 : /\b(two|2) weeks\b/i.test(text) ? 14 : 7), 1), 30);
      if (!isConnected(ctx, "gmail")) return { intent: "inbox_review", reply: "Gmail isn't connected, so I can't read your email. Connect it in Connections & Permissions.", section: "permissions" };
      const spam = /\b(spam|junk)\b/i.test(text);
      return later("inbox_review", `On it: I'm reading your ${spam ? "spam folder" : "email"} from the last ${days} days with the local model, one message at a time. This takes a few minutes; the answer will appear under “Your requests” on Today, and you'll get a notification if they're on.`, (p) => reviewInbox(ctx, days, p, undefined, 30, spam ? "in:spam" : "in:inbox"));
    }
    case "email_question": {
      const query = a.query?.trim() || text;
      return later("email_question", "Looking through your mail for the answer with the local model. It will appear under “Your requests” on Today.", (p) => emailQuestion(ctx, text, query, p));
    }
    case "meeting_prep": {
      const who = a.who?.trim() || a.query?.trim() || text;
      return later("meeting_prep", `Preparing a brief for “${who}” from your calendar, recent emails and notes. It will appear under “Your requests” on Today.`, (p) => meetingPrep(ctx, text, who, p));
    }
    case "weather":
      return answer("weather", await weatherAnswer(ctx, text, a.query?.trim() || null));
    case "email_search":
      return answer("email_search", await emailSearch(ctx, a.query?.trim() || text, a.days));
    case "agenda":
      return answer("agenda", await agenda(ctx, text));
    case "add_event":
      return runIntent(ctx, text, { intent: "event", query: eventText(text) }, workflows);
    case "add_flights":
      return runIntent(ctx, text, { intent: "flights" }, workflows);
    case "reminder_from_email": {
      const query = a.query?.trim() || text;
      if (!isConnected(ctx, "gmail")) return { intent: "reminder_from_email", reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
      return later("reminder_from_email", "Looking for it in your emails with the local model; the reminder will be set ahead of the deadline. The answer will appear under “Your requests” on Today.", (p) => reminderFromEmail(ctx, text, query, p));
    }
    case "deadlines_to_reminders": {
      const days = Math.min(Math.max(a.days ?? (/\bmonth\b/i.test(text) ? 30 : 7), 1), 30);
      if (!isConnected(ctx, "gmail")) return { intent: "deadlines_to_reminders", reply: "Gmail isn't connected, so I can't read your email. Connect it in Connections & Permissions.", section: "permissions" };
      return later("deadlines_to_reminders", `Reading your email from the last ${days} days with the local model, then adding a reminder for each deadline or action. This takes a while; the answer will appear under “Your requests” on Today.`, (p) => deadlinesToReminders(ctx, days, p));
    }
    case "trip_weather":
      return answer("trip_weather", await tripWeather(ctx));
    case "prep_day":
      return later("prep_day", "Preparing a brief for each meeting from your calendar, recent emails and notes. The answer will appear under “Your requests” on Today.", (p) => prepDay(ctx, text, p));
    case "nudge_all":
      return answer("nudge_all", await nudgeAll(ctx));
    case "event_from_web": {
      const query = a.query?.trim() || text;
      return later("event_from_web", "Looking up the event on the web (privately, your own SearXNG) with the local model. Once I find its date, it will be ready to add to your calendar (you approve it). The answer will appear under “Your requests” on Today.", (p) => eventFromEmail(ctx, text, query, p, undefined, findEventOnWeb));
    }
    case "reply_and_add": {
      const who = a.who?.trim();
      if (!who) return { intent: "reply_and_add", reply: "Who should I reply to? e.g. “tell Laura yes for dinner and add it to my calendar”." };
      if (!isConnected(ctx, "gmail")) return { intent: "reply_and_add", reply: "Gmail isn't connected, so I can't find the email to reply to. Connect it in Connections & Permissions.", section: "permissions" };
      const message = a.message?.trim() || text;
      return later("reply_and_add", `Writing the reply to ${who} and finding the event in their email. Both will wait for your approval; the answer will appear under “Your requests” on Today.`, async (p) => {
        const reply = await draftReplyFree(ctx, who, message, p);
        const event = await eventFromEmail(ctx, text, `from:"${who.replace(/"/g, "")}" newer_than:90d`, p);
        return { reply: `${reply.reply}\n\n${event.reply}`, items: [...(reply.items ?? []), ...(event.items ?? [])], actionId: reply.actionId ?? event.actionId, section: reply.actionId || event.actionId ? "actions" : undefined };
      });
    }
    case "event_from_email": {
      const query = a.query?.trim() ?? "";
      if (!isConnected(ctx, "gmail")) return { intent: "event_from_email", reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
      return later("event_from_email", "Looking for the event in your emails with the local model. Once I find its date, it will be ready to add to your calendar (you approve it). The answer will appear under “Your requests” on Today.", (p) => eventFromEmail(ctx, text, query, p));
    }
    case "reminder": {
      // "Send a reminder to Tom…", "remind Laura…" are about someone else: a nudge, not a to-do for the user.
      const other = text.match(/\b(?:send (?:a )?(?:reminder|nudge) to|remind|chase)\s+(?!me\b|myself\b)([A-Z][\p{L}'-]+)/u);
      if (other) return answer("nudge", await nudge(ctx, other[1]));
      return answer("reminder", reminderFromText(ctx, text));
    }
    case "draft_reply": {
      if (!a.who) return { intent: "help", reply: "Who should I reply to? Say for example “reply to Ana that Thursday works”." };
      const who = a.who;
      // The writer gets the user's own request, not the model's paraphrase of it.
      const message = text;
      return later("draft", `Writing a reply to ${who} with the local model. It will wait for your approval in the Action Queue; the request board shows when it's ready.`, (p) => draftReplyFree(ctx, who, message, p));
    }
    case "nudge":
      if (!a.who) return answer("waiting_on", await waitingOn(ctx));
      return answer("nudge", await nudge(ctx, a.who));
    case "waiting_on":
      return answer("waiting_on", await waitingOn(ctx));
    case "trips":
      return answer("trips", await trips(ctx));
    case "subscriptions":
      return answer("subscriptions", await subscriptions(ctx));
    case "notes_search": {
      const query = a.query?.trim() || text;
      return later("notes", `Looking in your notes for “${query}” and writing an answer with the local model. It will appear under “Your requests” on Today.`, (p) => notesAnswer(ctx, query, p));
    }
    case "briefing":
      return runIntent(ctx, text, { intent: "briefing" }, workflows);
    case "weekly_review":
      return runIntent(ctx, text, { intent: "weekly" }, workflows);
    case "followups":
      return runIntent(ctx, text, { intent: "followups" }, workflows);
    case "pending_approvals":
      return runIntent(ctx, text, { intent: "pending" }, workflows);
    case "schedules":
      return runIntent(ctx, text, { intent: "schedule" }, workflows);
    case "remember": {
      // Only what the user actually asked to remember, in their own words: a question routed here by
      // mistake must never become a stored "fact" (the model once invented one).
      if (!/\b(remember|note that|keep in mind|for future reference|from now on)\b/i.test(text)) {
        // "Don't let me forget to buy milk", "add a to-do: …" are reminders; anything else is a question.
        if (/\b(forget|to-?do|task|remind)\b/i.test(text)) return runSkill(ctx, text, { skill: "reminder", args: {} }, workflows);
        return runSkill(ctx, text, { skill: "notes_search", args: { query: text } }, workflows);
      }
      const fact = text.replace(/^\s*(?:please\s+)?(?:remember|note|keep in mind)(?:\s+that)?\s*:?\s*/i, "").trim();
      return runIntent(ctx, text, { intent: "remember", query: fact }, workflows);
    }
    case "propose_times":
      if (!a.who) return { intent: "help", reply: "Who should I offer times to? Say for example “propose times to Ana for 30 minutes”." };
      return runIntent(ctx, text, { intent: "slots", target: a.who, query: a.minutes ? String(a.minutes) : undefined }, workflows);
    case "web_search": {
      // Search engines read questions well: the user's own words, without "search the web for".
      const query = text.replace(/^\s*(?:please\s+)?(?:(?:can|could) you\s+)?(?:search|look up|google|check)(?: (?:the web|the internet|online))?(?: for)?\s+/i, "").trim() || a.query?.trim() || text;
      return later("web_search", "Searching the web privately (your own SearXNG) and reading the top pages with the local model. The answer will appear under “Your requests” on Today.", (p) => webAnswer(ctx, text, query, p));
    }
    default:
      return { intent: "unsupported", unsupported: true, reply: `I can't do that yet${a.reason ? ` (${a.reason})` : ""}. ${CAN_DO}` };
  }
}

async function runIntent(ctx: Ctx, text: string, routed: { intent: Intent; query?: string; target?: string }, workflows: WorkflowRegistry): Promise<CommandResult> {
  const { intent, query, target } = routed;
  logActivity(ctx, { actor: "user", kind: "agent_run", agentId: "chief_of_staff", outcome: intent === "refused" ? "denied" : "info", summary: `Asked the Chief of Staff (${intent})` });

  switch (intent) {
    case "refused": {
      // Say why, for what was actually asked.
      const why = /password|passcode|api key|token/i.test(text)
        ? "I never handle passwords, tokens or keys."
        : /\b(pay|transfer|wire)\b/i.test(text)
          ? "I never move money: pay or transfer it yourself. I can tell you which bills are waiting (“any bills I need to pay?”)."
          : /\b(delete|remove)\b/i.test(text)
            ? "I don't delete anything: remove it yourself where it lives (Knowledge & Data, Reminders, the Action Queue)."
            : /permission|access|grant|disconnect/i.test(text)
              ? "Access changes only in Connections & Permissions, by you."
              : "Approving happens only in the Action Queue, after you review the exact content.";
      return { intent, reply: `I can't do that. ${why}`, section: /permission|access|grant|disconnect/i.test(text) ? "permissions" : /delete|remove/i.test(text) ? "knowledge" : "actions" };
    }
    case "automation": {
      const hooks = listWebhooks(ctx);
      const hook = hooks.find((h) => h.name.toLowerCase() === target!.toLowerCase()) ?? hooks.find((h) => h.name.toLowerCase().includes(target!.toLowerCase()));
      if (!hook) return { intent, reply: hooks.length ? `No webhook called “${target}”. Yours: ${hooks.map((h) => h.name).join(", ")}.` : "No webhooks yet. Add one in Settings → Automations.", section: "permissions" };
      let proposed: { actionId: string };
      try {
        proposed = await callTool(
          ctx,
          "follow_up",
          "actions.propose",
          {
            serviceId: hook.id,
            kind: "webhook",
            title: `${hook.name}: ${query!.slice(0, 80)}`,
            payload: { hookId: hook.id, fields: { text: query! } },
            idempotencyKey: `cmd:${hook.id}:${createHash("sha256").update(query!).digest("hex").slice(0, 16)}:${ctx.now().toISOString().slice(0, 16)}`,
          },
          new RunBudget(1, 5000),
        );
      } catch (err) {
        if ((err as { code?: string }).code === "POLICY_DENIED") {
          return { intent, reply: `The Follow-up agent isn't allowed to prepare calls to “${hook.name}” yet. Grant it in Connections & Permissions (service and agent).`, section: "permissions" };
        }
        throw err;
      }
      return { intent, ref: { actionId: proposed.actionId }, reply: `Proposed a call to “${hook.name}”. Nothing is sent until you approve the exact payload in the Action Queue.`, section: "actions" };
    }
    case "draft": {
      const who = target!.toLowerCase();
      const msg = all<{ id: string; sender: string; subject: string; thread_id: string | null; rfc_message_id: string | null }>(
        ctx.db,
        "SELECT id, sender, subject, thread_id, rfc_message_id FROM messages WHERE source = 'gmail' AND lower(sender) LIKE ? ORDER BY received_at DESC LIMIT 1",
        `%${who.replace(/[%_]/g, "")}%`,
      )[0];
      if (!msg) return { intent, reply: `No synced Gmail message from “${target}”. Sync Gmail first, or check the name.`, section: "today" };
      const { name, email } = parseSender(msg.sender);
      if (!email) return { intent, reply: "Couldn't read that sender's address.", section: "today" };
      let proposed: { actionId: string };
      try {
        proposed = await callTool(
          ctx,
          "follow_up",
          "actions.propose",
          {
            serviceId: "gmail-drafts",
            kind: "email_draft",
            title: `Gmail draft: reply to ${name ?? email} — ${msg.subject}`.slice(0, 200),
            payload: {
              to: email,
              subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
              body: query!,
              ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
              ...(msg.rfc_message_id ? { inReplyTo: msg.rfc_message_id } : {}),
            },
            idempotencyKey: `cmd-draft:${msg.id}:${createHash("sha256").update(query!).digest("hex").slice(0, 16)}:${minuteStamp(ctx)}`,
          },
          new RunBudget(1, 5000),
        );
      } catch (err) {
        if ((err as { code?: string }).code === "POLICY_DENIED") {
          return { intent, reply: "The Follow-up agent can't prepare Gmail drafts yet. Connect “Gmail drafts” and grant it in Connections & Permissions.", section: "permissions" };
        }
        throw err;
      }
      return { intent, ref: { actionId: proposed.actionId }, reply: `Proposed a Gmail draft to ${email}. Review it in the Action Queue; once approved it appears in your Gmail Drafts — it is never sent automatically.`, section: "actions" };
    }
    case "briefing":
      return startWorkflow(ctx, "daily_briefing", "morning briefing", workflows);
    case "weekly":
      return { ...startWorkflow(ctx, "weekly_review", "weekly review", workflows), intent };
    case "followups":
      return { ...startWorkflow(ctx, "followup_sweep", "follow-up sweep", workflows), intent, section: "actions" };
    case "search": {
      // Semantic only when the model is installed AND notes have been indexed; otherwise keywords.
      const provider = nanoModelInstalled() && knowledgeStats(ctx).localVectors > 0 ? "local-semantic" : "lexical";
      // Notes are read through the Knowledge agent's permission, like every other data access (the
      // Chief of Staff has no data access of its own).
      if (!check(ctx, "knowledge", "demo-notes", "read")) return { intent, reply: "The Knowledge agent has no read access to your notes. Grant it in Connections & Permissions.", section: "permissions" };
      const res = await retrieve(ctx, { query: query!, provider, k: 3 }, undefined, "chief_of_staff");
      return {
        intent,
        reply: res.passages.length ? `Top notes for “${query}” (${provider === "lexical" ? "keyword" : "semantic"} search, local):` : `Nothing found for “${query}”.`,
        items: res.passages.map((p) => ({ title: p.title, detail: `${p.text.slice(0, 140)}${p.text.length > 140 ? "…" : ""}${p.flags.length ? " ⚠ contains instruction-like text (treated as data)" : ""}` })),
        section: "tech",
      };
    }
    case "schedule": {
      const jobs = listJobs(ctx);
      return {
        intent,
        reply: `${jobs.filter((j) => j.status === "active").length} active schedule(s):`,
        items: jobs.map((j) => ({ title: j.name, detail: j.status !== "active" ? `${j.status}${j.status_reason ? ` — ${j.status_reason}` : ""}` : j.next_run_at ? `next run ${new Date(j.next_run_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: j.timezone })}` : "no further runs" })),
        section: "schedules",
      };
    }
    case "pending": {
      const rows = all<{ title: string; status: string }>(ctx.db, "SELECT title, status FROM actions WHERE status IN ('proposed','approved') ORDER BY created_at DESC LIMIT 8");
      return { intent, reply: rows.length ? `${rows.length} item(s) waiting for you:` : "Nothing is waiting for your approval.", items: rows.map((r) => ({ title: r.title, detail: r.status })), section: "actions" };
    }
    case "slots":
      return proposeSlots(ctx, target!, query ? Number(query) : 30);
    case "remember": {
      try {
        addFact(ctx, query!);
      } catch (err) {
        return { intent, reply: err instanceof Error ? err.message : "Couldn't save that." };
      }
      return { intent, reply: `Saved to About me: “${query}”. Agents use it when writing for you; edit or remove it in Knowledge & Data.`, section: "knowledge" };
    }
    case "event": {
      const prepared = parseEventRequest(query!, ctx.now(), config().timezone);
      if ("error" in prepared) return { intent, reply: prepared.error };
      const manual = (note = "") => {
        logActivity(ctx, { actor: "calendar", kind: "agent_run", agentId: "calendar", outcome: "info", summary: `Prepared a calendar event for you to add: ${prepared.title.slice(0, 80)} (nothing written)` });
        return {
          intent,
          reply: `Here is the event. Check it, then add it to Google Calendar (Google opens the event pre-filled; nothing is saved until you click Save there) or download it for any calendar app.${note}`,
          event: prepared,
        };
      };
      if (calendarMode(ctx) === "link") return manual();
      const proposed = await proposeEvent(ctx, prepared);
      if ("approval" in proposed) return { intent, ref: { actionId: proposed.approval.actionId }, event: prepared, approval: proposed.approval, reply: `Ready to add to your “${proposed.approval.calendar}” calendar. Approve it here or in the Action Queue.` };
      return manual(proposed.why);
    }
    case "flights":
      return addFlights(ctx);
    case "today": {
      const start = new Date(ctx.now());
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86_400_000);
      const events = all<EventRow>(ctx.db, `SELECT * FROM events WHERE starts_at >= ? AND starts_at < ?${demoRowsFilter()} ORDER BY starts_at`, start.toISOString(), end.toISOString());
      return {
        intent,
        reply: events.length ? `${events.length} event(s) today:` : "Nothing on your calendar today.",
        items: events.map((e) => ({ title: `${new Date(e.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ${e.title}`, detail: e.location ?? undefined })),
        section: "today",
      };
    }
    default:
      if (query === "calendar") {
        return {
          intent: "help",
          reply: "I can add one event at a time (“add event: dentist tuesday 3pm at Riverside Dental”, or in French “rdv : dîner vendredi 20h”) or the flights from your booking emails (“add my flights to my calendar”). Each one waits for your click.",
        };
      }
      return { intent: "help", reply: HELP };
  }
}
