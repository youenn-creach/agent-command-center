import { z } from "zod";
import { parseRange } from "./when";
import { judgeAnswer, selfCheckOn } from "./selfcheck";
import { modelSplit, modelSplitOn } from "./split";
import { CHOICE_SKILLS, recordCorrection } from "./corrections";
import { cloudRouter } from "../cloudRouter";
import { autoRun, draftFacts, eventFacts } from "../autopilot";
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
import { localToday, parseEventRequest, zonedToUtc, type PreparedEvent } from "./eventParse";
import { addFact, listFacts } from "../memory";
import { findFreeSlots, formatSlots, workingHoursFromFacts } from "./slots";
import { recordRequest } from "../requests";
import { appMode, demoRowsFilter } from "../mode";
import { check } from "../policy/engine";
import { getAction } from "../approvals";
import { APP_CALENDAR_NAME } from "../connectors/google";
import { calendarMode } from "../calendarMode";
import { alreadyInCalendar, flightEvent, flightKey, upcomingFlights } from "./flights";
import { checkInReminder, deadlinesToReminders, reminderAtEvent, reminderBeforeEvent, nudgeAll, prepDay, reminderFromEmail, tripWeather } from "./chains";
import { eventsBetween, namedEventAnswer, agenda, CAN_DO_SHORT, draftReplyFree, emailQuestion, findEventInEmail, findEventOnWeb, webAnswer, emailSearch, meetingPrep, notesAnswer, contactLookup, notesLikely, nudge, priorities, remindersList, quickRoute, reminderFromText, routeRequest, searchWords, subscriptions, trips, waitingOn, weatherAnswer, clarify, type Route, type Skill, type SkillAnswer } from "./assistant";
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

export const CommandSchema = z.object({ text: z.string().trim().min(1).max(500) });
/** "Not right?": the request again, with the kind of request the user picked (only the offered choices). */
export const ChosenSchema = z.object({ text: z.string().trim().min(1).max(500), skill: z.enum(CHOICE_SKILLS), wrong: z.string().max(40).optional() });

export type Intent =
  | "priorities" | "contact_lookup" | "reminders_list" | "inbox_review" | "email_search" | "email_question" | "event_from_email" | "reminder_from_email" | "deadlines_to_reminders" | "trip_weather" | "prep_day" | "nudge_all" | "event_from_web" | "reply_and_add" | "meeting_prep" | "weather" | "agenda" | "reminder" | "nudge" | "waiting_on" | "trips" | "subscriptions" | "notes" | "web_search" | "unsupported"
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
  /** The assistant asked a question instead of acting (last resort). Simulations count it as a miss. */
  asked?: boolean;
  /** How the request was understood: by the local model (and which one) or by an exact command. */
  understood?: string;
  /** The skill that answered, when one did (offered with alternatives under the answer: "not right?"). */
  skill?: string;
  /** Autopilot did it without a click (the action is in "Done for you" on Today, with Undo). */
  auto?: boolean;
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
  // "propose some times to Jordan for a call next week": the person is "Jordan", not the rest of the sentence.
  if (slots) return { intent: "slots", target: slots[1].trim().replace(/\s+(?:for|about|on|next|this|tomorrow|today|to|regarding)\b.*$/i, "").trim() || slots[1].trim(), query: slots[2] ? String(/^h/i.test(slots[3]) ? +slots[2] * 60 : +slots[2]) : undefined };
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
  "I can: run your briefing (“brief me”), run the weekly review, draft follow-ups, search your notes (“find Lisbon”), show what's scheduled, what's waiting for approval, today's agenda, add a calendar event (“add event: dentist tuesday 3pm”), add the flights from your booking emails (“add my flights to my calendar”), propose free times in a reply (“propose times to Ana”), remember something about you (“remember I prefer short replies”), prepare a webhook call (“trigger Todoist: buy milk”) or a Gmail reply draft (“draft reply to Ana: sounds good!”) for your approval.";

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
async function proposeSlots(ctx: Ctx, who: string, durationMin: number, nextWeek = false): Promise<CommandResult> {
  const intent = "slots" as const;
  const tz = config().timezone;
  // "…next week": the search starts on next Monday instead of now.
  const start = nextWeek ? parseRange("next week", ctx.now(), tz).from : ctx.now();
  const from = new Date(start.getTime() - 86_400_000).toISOString();
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
  const slots = formatSlots(findFreeSlots(events, start, tz, { durationMin: Math.min(Math.max(durationMin, 15), 240), ...hours }), tz);
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
    const auto = await autoRun(ctx, out.actionId, "typed", draftFacts(ctx, `${who} ${name ?? ""}`, email, name));
    if (auto.auto) return { intent, ref: { actionId: out.actionId }, auto: true, reply: `Done for you: a reply to ${name ?? email} with these times is in your Gmail Drafts (never sent). Undo it under “Done for you” on Today.`, items, section: "today" };
    return { intent, ref: { actionId: out.actionId }, reply: `Drafted a reply to ${name ?? email} with these times. Review it in the Action Queue${real ? "; once approved it lands in your Gmail Drafts" : ""}.${autopilotNote(ctx, auto.why)}`, items, section: "actions" };
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

/** When the owner has autopilot on for something and it still waits, one short reason (nothing when autopilot is off). */
function autopilotNote(ctx: Ctx, why: string): string {
  return /off for this kind|always waits/.test(why) ? "" : ` (Autopilot didn't add it on its own: ${why}.)`;
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
export async function runCommand(ctx: Ctx, rawText: string, workflows: WorkflowRegistry, llm?: LlmProvider, checker?: LlmProvider, chosen?: { skill: Skill; wrong?: string }): Promise<CommandResult> {
  const { text } = CommandSchema.parse({ text: rawText });
  let result: CommandResult;
  if (chosen) {
    // "Not right?": the user picked the kind of request; it runs that way (same permissions and approvals as always) and is kept as an example.
    recordCorrection(ctx, text, chosen.wrong, chosen.skill);
    result = { ...(await runSkill(ctx, text, { skill: chosen.skill, args: {} }, workflows, true)), skill: chosen.skill, understood: "your choice" };
  } else result = await handle(ctx, text, workflows, llm);
  // Requests the model routed get the self-check (exact commands and quick rules are deterministic; asks and refusals are final).
  if (selfCheckOn(ctx) && /·|two requests/.test(result.understood ?? "") && !result.asked && !result.unsupported) result = await withSelfCheck(ctx, text, result, workflows, checker);
  const id = recordRequest(ctx, text, result);
  const { background, ...reply } = result;
  if (background && id) runInBackground(ctx, id, text, background);
  return reply;
}

/**
 * Background requests run one at a time, in the order they were asked: the local model does one job
 * well on a laptop CPU, and two jobs on different models would keep unloading each other's model.
 * Held on globalThis so every route of this process shares the one queue.
 */
const background = ((globalThis as { __accBackground?: { tail: Promise<void>; pending: number } }).__accBackground ??= { tail: Promise.resolve(), pending: 0 });
/** Longer than any request's own model deadlines; past it, the queue moves on rather than wait forever. */
const BACKGROUND_MAX_MS = 60 * 60_000;

/** Background work: progress and the final answer go to the request board, plus a notification. */
export function runInBackground(ctx: Ctx, id: string, text: string, work: NonNullable<CommandResult["background"]>) {
  const ahead = background.pending++;
  if (ahead > 0) setRequestProgress(ctx, id, `Waiting for ${ahead === 1 ? "your other request" : `${ahead} other requests`} to finish…`);
  background.tail = background.tail.then(async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("it took more than an hour")), BACKGROUND_MAX_MS);
        timer.unref();
      });
      setRequestProgress(ctx, id, "Starting…");
      const out = await Promise.race([work((p) => setRequestProgress(ctx, id, p)), deadline]);
      finishRequest(ctx, id, { ok: true, reply: out.reply, items: out.items, actionId: out.actionId });
      void notify(ctx, { key: `answer:${id}`, kind: "answer", title: "Your request is ready", summary: "The Chief of Staff finished a request.", detail: text.slice(0, 120) });
    } catch (err) {
      finishRequest(ctx, id, { ok: false, reply: `This didn't work: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}` });
    } finally {
      clearTimeout(timer);
      background.pending--;
    }
  });
}

/** Commands with an exact form ("add event: …", "draft reply to Ana: …") run without the model. */
const EXACT: ReadonlySet<Intent> = new Set(["draft", "event", "remember", "slots", "automation", "flights", "refused"]);

// Two asks in one request ("what's my day tomorrow and is it going to rain"): each half is understood on its own, the
// answers are put together. Only when the second half starts with a request verb, so "lunch with Sam and Priya" stays one.
const SECOND_ASK = /,?\s+(?:and if not,?|if not,?|and if (?:he|she|they|it)\s+(?:still\s+)?(?:hasn'?t|has not|haven'?t|have not|didn'?t|did not|isn'?t|is not)(?:\s+yet)?,?|and then|and also|and|then|also)\s+(?=(?:remind me|let [\p{L}'-]+ know\b|tell |email |e-mail |message |text |write |reply |chase |nudge |follow up|is it |is anything |is there |will it |are there |do i |am i |has |have |did |does |whether |what\b|who\b|when\b|where\b|how\b|check |find |look up|set |send |draft |show |give me|put |add ))/iu;
const FREE_TEXT_START = /^(?:remind me|remember|add a (?:reminder|to-?do|task)|note that|don'?t let me forget)\b/i;

/** The two halves of a request that asks two things, or null. Pure. */
export function splitAsks(text: string, knownPeople: string[] = []): [string, string] | null {
  // "put a reminder on friday at 5pm to water the plants and another on saturday morning to buy bread": two reminders.
  const another = text.match(/^(.*?\b(?:put|add|set|create|make)\s+(?:in\s+)?(?:a\s+)?reminder\b.*?)\s+and\s+(?:another|one more)(?:\s+reminder)?\s+(.+)$/i);
  if (another) return [another[1].trim(), `remind me ${another[2].trim()}`];
  const m = SECOND_ASK.exec(text);
  if (!m) return null;
  const a = text.slice(0, m.index).trim().replace(/[,;]+$/, "");
  let b = text.slice(m.index + m[0].length).trim();
  if (a.split(/\s+/).length < 2 || b.split(/\s+/).length < 2) return null;
  // "... and add it to my calendar" continues the first half (a chain the router already knows).
  if (/^(?:add|put|save)\s+(?:it|them|that|this|those|the (?:date|event|time|details?))\b/i.test(b)) return null;
  if (/^(?:email|tell|message|text|write|reply|chase|nudge|let)\b/i.test(b) === false && FREE_TEXT_START.test(a)) return null;
  // A reminder's own text can mention a person ("remind me to call mom and tell her…"): split only before a named person.
  // ...unless the first half names someone the user deals with ("…at the landlord's and tell him…"): then "him" is them.
  const knownInA = knownPeople.find((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(a));
  if (FREE_TEXT_START.test(a) && /^(?:tell|email|e-mail|message|text|write|reply|chase|nudge|let)\s+(?:to\s+)?(?:her|him|them|me|everyone|everybody|people|you)\b/i.test(b)) {
    if (!knownInA || /^(?:tell|email|e-mail|message|text|write|reply|chase|nudge|let)\s+(?:to\s+)?(?:me|everyone|everybody|people|you)\b/i.test(b)) return null;
    b = b.replace(/\b(?:her|him|them)\b/i, `the ${knownInA}`.replace(/^the ([A-Z])/, "$1"));
  }
  // "check my mail for X and set a reminder before it renews": one chain (find in the mail, then remind), not two requests.
  if (/\b(?:my|the)\s+(?:e-?mails?|mails?|inbox|gmail)\b|\bgmail\b/i.test(a) && /^(?:set|add|create|make)\s+(?:me\s+)?(?:a\s+)?(?:reminder|to-?do)\b|^remind me\b/i.test(b) && /\b(?:it|that|they|them)\b/i.test(b)) return null;
  // "check my mail for the invoice and tell me the amount": the second half says what to report about the first; one request.
  if (/^(?:please\s+)?(?:check|look (?:at|through|in)|go through|search|find|scan|read|review)\b/i.test(a) && /^(?:tell me|show me|give me|let me know)\b/i.test(b)) return null;
  // A second half that points back at the first ("the weather there", "prepare for any of it") is one request.
  if (/\b(?:there|any of (?:it|them)|that day|the same (?:day|place|time))\b/i.test(b)) return null;
  // "what time is the committee and where is it": a second question about the same thing.
  if (/^(?:where|what time|when|how long|who)\s+(?:is|was|does|will)\s+(?:it|that|this)\b/i.test(b)) return null;
  // "remind me to read it": the reminder needs to say what "it" is.
  const topic = a.match(/\b(?:for|about|on|to)\s+the\s+([\p{L}' -]{3,40}?)(?:\s+(?:and|to|on|at|in)\b|$)/u)?.[1]?.trim();
  if (topic && /^remind me to \w+ (?:it|that|them)\s*$/i.test(b)) b = `${b.trim()} (about the ${topic})`;
  // "email her to confirm", "what did she ask": the pronoun is the one person the first half names.
  const names = [...new Set([...a.matchAll(/\b([A-Z][\p{L}'-]{2,})\b/gu)].map((x) => x[1]).filter((n, i) => !(i === 0 && a.startsWith(n)) && !/^I['’]/.test(n) && !/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/.test(n)))];
  // A name typed in lowercase after a verb ("chase priya about the quote") counts too.
  const typed = a.match(/\b(?:chase|nudge|tell|email|e-mail|ask|call|text|message|with|from)\s+(?!me\b|him\b|her\b|them\b|the\b|my\b|a\b|an\b|everyone\b|everybody\b|someone\b)([\p{L}][\p{L}'-]{2,})\b/iu)?.[1];
  const person = a.match(/\bwith\s+([A-Z][\p{L}'-]+)/u)?.[1] ?? (names.length === 1 ? names[0] : typed ? typed.charAt(0).toUpperCase() + typed.slice(1) : knownInA);
  if (person) b = b.replace(/\b(?:her|him|them|she|he)\b/i, person);
  // "summarize the maria email and draft a yes": the reply is to the person the first half is about.
  const replyWord = b.match(/^(?:draft|write|send|prepare)\s+(?:a|an)\s+(yes|no|reply|answer|thank[- ]?you|thanks)\b(.*)$/i);
  const about = knownInA ?? person;
  if (replyWord && about) b = `reply to ${about}: ${replyWord[1]}${replyWord[2]}`;
  // "what did the landlord say and reply that tuesday is fine": the reply goes to the one the first half is about.
  const bareReply = b.match(/^(?:reply|answer|respond|write back)\s+((?:that|saying|to say|yes|no)\b.*)$/i);
  if (bareReply && about) b = `reply to ${about} ${bareReply[1]}`;
  // "how much is quote B and what does it include": "it" is what the first half asks about.
  const askedAbout = a.match(/^(?:how much|what|when|where|how long|how big|how far)\b.*?\b(?:is|are|was|does|do)\s+(?:the\s+|my\s+)?([\p{L}\d][\p{L}\d' -]{1,30}?)\s*\??$/iu)?.[1];
  // Never the "it" of the weather or of "is it ok/too late" ("when is lunch and is it going to rain").
  const dummyIt = /\b(?:is|will|does|did)\s+it\s+(?:going to\s+|gonna\s+)?(?:rain|snow|be\s+(?:sunny|cold|hot|warm|windy|nice|wet|dry)|sunny|cold|hot|warm|windy|ok|okay|too|worth|possible|late|early|safe)\b|\bit'?s\b|\bweather\b/i;
  if (askedAbout && /^(?:what|how|when|where|which|who|is|does|do|did|can)\b/i.test(b) && /\bit\b/i.test(b) && !dummyIt.test(b) && !/\bit\b/i.test(askedAbout)) b = b.replace(/\bit\b/i, askedAbout);
  // "how much is the insurance and remind me 2 weeks before it renews": "it" is what the first half is about.
  if (/^(?:please\s+)?(?:remind me|set (?:me )?a reminder)\b/i.test(b) && /\bit\b/i.test(b) && !/\(about /.test(b)) {
    const subject = searchWords(a).split(/\s+/).slice(0, 3).join(" ");
    if (subject) b = b.replace(/\bit\b/i, `the ${subject}`);
  }
  return [a, b];
}

/** What a reply should say, taken from the request: "can u tell the landlord thursday is fine" -> "thursday is fine". The whole request if it can't be told apart. */
export function replyContent(text: string, who: string): string {
  // "what should I reply to the landlord": no content given; the writer answers the email itself.
  if (/^\s*what (?:should|do|can) i (?:reply|answer|say|write)\b/i.test(text)) return "";
  const t = text.trim().replace(/^(?:please\s+)?(?:can|could|would)\s+(?:you|u)\s+/i, "");
  const name = who.replace(/<.*$/, "").trim();
  const words = name.split(/\s+/).filter(Boolean);
  for (const w of [name, words[0]].filter(Boolean)) {
    // The name as a whole word: "Al" must not match inside "really".
    const hit = new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").exec(t);
    if (!hit) continue;
    const after = t.slice(hit.index + w.length).replace(/^[\s,:;-]+/, "").replace(/^(?:know\s+)?(?:that\s+)?(?:saying\s+)?/i, "").replace(/^[\s,:;-]+/, "").trim();
    if (after.split(/\s+/).length >= 2) return after;
  }
  return t;
}

/** Skills that prepare or create something (drafts, follow-ups, reminders, events, saved facts) rather than only answer. */
const ACTING_SKILLS = new Set<string>(["add_event", "add_flights", "event_from_email", "reminder", "reminder_from_email", "deadlines_to_reminders", "nudge_all", "event_from_web", "reply_and_add", "draft_reply", "nudge", "followups", "remember", "propose_times"]);

/**
 * Wraps a result with the self-check: the answer (now, or when the background work ends) is judged against the request; if it
 * misses and the checker names a better skill, that skill runs once and its answer is shown instead. Two-part requests are
 * checked but not retried (each half was routed on its own).
 */

async function withSelfCheck(ctx: Ctx, text: string, result: CommandResult, workflows: WorkflowRegistry, checker?: LlmProvider): Promise<CommandResult> {
  const compound = /two requests/.test(result.understood ?? "");
  const retry = async (answer: SkillAnswer, progress: (s: string) => void): Promise<SkillAnswer | CommandResult | null> => {
    progress("Checking the answer…");
    // The skill that answered (a skill name like the checker's), not the app intent ("draft", "notes").
    const used = result.skill ?? result.intent;
    const v = await judgeAnswer(ctx, text, used, answer, checker);
    if (v.ok || compound || !v.skill || v.skill === used || v.skill === "unsupported") return null;
    // An action the wording asked for (a nudge, a draft, a reminder, an event) is never traded for a read-only answer:
    // the action is already prepared, and the read-only reply would contradict it (held-out batch 9, "nudge priya and tom").
    if (ACTING_SKILLS.has(used) && !ACTING_SKILLS.has(v.skill)) return null;
    // ...and a question is never turned into an action: "what's on my tax checklist" once became three reminders from the mail.
    if (!ACTING_SKILLS.has(used) && ACTING_SKILLS.has(v.skill)) return null;
    logActivity(ctx, { actor: "chief_of_staff", kind: "agent_run", agentId: "chief_of_staff", outcome: "info", summary: `Self-check: “${used}” missed (${v.missing.slice(0, 80)}); retried as “${v.skill}”` });
    progress(`Trying again with ${v.skill}…`);
    return runSkill(ctx, text, { skill: v.skill, args: {} }, workflows);
  };
  if (result.background) {
    const work = result.background;
    return {
      ...result,
      background: async (progress) => {
        const first = await work(progress);
        const again = await retry(first, progress);
        if (!again) return first;
        const r = again as CommandResult;
        return r.background ? r.background(progress) : { reply: r.reply, items: r.items, actionId: r.ref?.actionId };
      },
    };
  }
  const again = await retry({ reply: result.reply, items: result.items }, () => {});
  return again ? { ...(again as CommandResult), understood: `${result.understood} · self-checked` } : result;
}

/** People the user deals with, for the splitter: first names, and roles from addresses ("landlord@…" -> landlord). */
function knownPeople(ctx: Ctx): string[] {
  const rows = [
    ...all<{ a: string }>(ctx.db, `SELECT recipient AS a FROM waiting_on WHERE 1 = 1${demoRowsFilter()}`),
    ...all<{ a: string }>(ctx.db, `SELECT sender AS a FROM messages WHERE 1 = 1${demoRowsFilter()} ORDER BY received_at DESC LIMIT 200`),
  ];
  const out = new Set<string>();
  for (const { a } of rows) {
    const name = a.replace(/\s*<[^>]*>/, "").replace(/"/g, "").trim();
    if (name && !name.includes("@")) out.add(name.split(/\s+/)[0]);
    // From the address alone: "landlord@…" -> landlord, "maria.lopez@…" -> maria.
    const local = (a.match(/<?([^<\s@]+)@/)?.[1] ?? "").toLowerCase().split(/[._-]/)[0];
    if (/^[a-z]{3,}$/.test(local) && !/^(?:no-?reply|info|hello|news|newsletter|billing|statements|support|policies|booking|noreply|team|contact|admin|mail)$/.test(local)) out.add(local);
  }
  return [...out].filter((p) => p.length > 2);
}

/** Runs both halves and returns one answer: replies in order, background work (the model reading mail) run one after the other. */
async function handleCompound(ctx: Ctx, parts: [string, string], workflows: WorkflowRegistry, llm?: LlmProvider): Promise<CommandResult> {
  const results: CommandResult[] = [];
  for (const part of parts) results.push(await handle(ctx, part, workflows, llm));
  // Two halves that land on the same answer ("when is my flight and what hotel do I have" -> trips twice) show it once.
  const join = (replies: string[]) => (replies.length === 2 && replies[0] === replies[1] ? replies[0] : replies.map((r, i) => `${i + 1}. ${r}`).join("\n\n"));
  const uniqueItems = <T extends { title: string; detail?: string }>(items: T[]) => items.filter((it, i) => items.findIndex((o) => o.title === it.title && o.detail === it.detail) === i);
  // One half done, the other not understood: ask about that half only (last resort), instead of a generic "I can't".
  results.forEach((r, i) => {
    const other = results[1 - i];
    if ((r.unsupported || r.intent === "help") && !r.asked && !(other.unsupported || other.intent === "help")) results[i] = { ...r, intent: "help", asked: true, unsupported: false, reply: clarify(ctx, parts[i]) };
  });
  const first = results.find((r) => r.event || r.events || r.approval);
  const out: CommandResult = {
    intent: results[0].intent,
    reply: join(results.map((r) => r.reply)),
    items: uniqueItems(results.flatMap((r) => r.items ?? [])),
    event: first?.event,
    events: first?.events,
    approval: first?.approval,
    section: results.find((r) => r.section)?.section,
    asked: results.some((r) => r.asked) || undefined,
    understood: `two requests: “${parts[0]}” and “${parts[1]}”`,
  };
  if (results.some((r) => r.background)) {
    out.background = async (progress) => {
      const done: SkillAnswer[] = [];
      for (const r of results) done.push(r.background ? await r.background(progress) : { reply: r.reply, items: r.items });
      return { reply: join(done.map((d) => d.reply)), items: uniqueItems(done.flatMap((d) => d.items ?? [])), actionId: done.find((d) => d.actionId)?.actionId };
    };
  }
  return out;
}

async function handle(ctx: Ctx, text: string, workflows: WorkflowRegistry, llm?: LlmProvider): Promise<CommandResult> {
  // A request a quick rule already understands as a whole is not split.
  // Only quick rules that read the whole two-part sentence ("find a free hour … and email Marc to propose it") stop the split;
  // a rule that matches the first half only ("what's on my calendar tomorrow and remind me …") must not.
  const whole = quickRoute(text);
  // The people the user deals with: read once per request (a 200-message scan), for the splitter and the router.
  let people: string[] | undefined;
  const peopleOnce = () => (people ??= knownPeople(ctx));
  let split: [string, string] | null = null;
  if (!(whole && ["propose_times", "unsupported", "nudge", "contact_lookup", "reminders_list"].includes(whole.skill))) {
    // The model's reading first when switched on (phase B); the wording rules when it is off or can't say.
    const read = modelSplitOn(ctx) ? await modelSplit(ctx, text, llm) : null;
    split = read === "one" ? null : (read ?? splitAsks(text, peopleOnce()));
  }
  if (split) return handleCompound(ctx, split, workflows, llm);
  const fast = classify(text);
  if (EXACT.has(fast.intent)) return { ...(await runIntent(ctx, text, fast, workflows)), understood: "exact command" };
  if (whole) return { ...(await runSkill(ctx, text, whole, workflows)), skill: whole.skill, understood: "quick rule (no model needed)" };
  let route: Awaited<ReturnType<typeof routeRequest>>;
  try {
    // Optional cloud help for understanding (Mistral API, free tier, request wording only): any failure falls back to the local model.
    const cloud = llm ? null : cloudRouter(ctx);
    route = cloud ? await routeRequest(ctx, text, cloud, peopleOnce()).catch(() => routeRequest(ctx, text, llm, peopleOnce())) : await routeRequest(ctx, text, llm, peopleOnce());
  } catch (err) {
    // No local model: fall back to keywords, and say so rather than guessing silently.
    const r = await runIntent(ctx, text, fast, workflows);
    const why = err instanceof Error ? err.message.slice(0, 120) : "unavailable";
    return { ...r, understood: "keywords (local model unavailable)", reply: fast.intent === "help" ? `I couldn't understand this one: the local model isn't available (${why}). ${HELP}` : r.reply };
  }
  return { ...(await runSkill(ctx, text, route, workflows)), skill: route.skill, understood: `${route.model} · ${Math.round(route.ms / 1000)} s` };
}

/** What a request asks to add, without the wrapper ("put … in my calendar"). */
function eventText(text: string) {
  return text
    .replace(/^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:add|put|schedule|create|book|set up|make|block|pencil)(?:\s+(?:in|down))?\s+(?:an?\s+)?(?:new\s+)?(?:event|appointment|meeting)?\s*:?\s*/i, "")
    .replace(/\s+(?:to|in|into|on)\s+(?:my\s+)?(?:calendar|agenda|schedule)\b(?:\s+as an event)?/i, "")
    .trim();
}

// A question about an amount or a date (what a bill, a renewal or a booking says).
const MONEY_OR_DATE = /\b(?:how much|cost|costs|price|amount|owe|pay|paid|premium|fee|bill|invoice|when does|when is|what date|renew\w*|expir\w*|due)\b/i;

// A request to put something in the calendar, and a day or time for it.
const ADD_EVENT_SHAPE = /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:add|put|schedule|book|block|pencil in|create|set up)\b/i;
const WHEN_GIVEN = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|the \d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|at \d{1,2}|in (?:\d{1,2}|a|one|two|three|four|five|six) (?:days?|weeks?|months?)|noon|midday)\b/i;

// "Find X in my email and add it to my calendar" is one request; the model sometimes picks one half.
const MAIL_WORD = /\b(e-?mails?|mail|inbox|gmail)\b/i;
const TO_CALENDAR = /\b(add|put|save|create)\b.*\b(calendar|agenda)\b/i;
const RELATIVE_BEFORE = /\b(?:the (?:day|week) before|\d+ (?:days?|weeks?) before|a (?:day|week) before)\b/i;
const FLIGHT_WORD = /\b(flights?|planes?|plane tickets)\b/i;
const TRAVEL_WORD = /\b(trips?|travel\w*|flights?|fly|flying|flies|planes?|airlines?|airports?|land(?:s|ing)?|depart\w*|take ?off|hotels?|stay\w*|nights?|bookings?|booked|reservations?|check-?in|check-?out|holidays?|vacations?|journey|trains?|abroad|destination|luggage|boarding|passport|gate|terminal|arriv\w*|guesthouse|airbnb|rental car|car rental|itinerar(?:y|ies)|visas?|(?:leave|leaving|go|going|head(?:ing)?|get(?:ting)?)\s+(?:to|for)\s+(?!the\s|my\s|a\s)[\p{L}]{3,})\b/iu;
// "Remind me to chase Laura on Monday" is a reminder for the user, even though it names someone to chase.
const SELF_REMINDER = /\b(remind (?:me|myself)|don'?t let me forget|set (?:a|me a) reminder|add a (?:reminder|to-?do|task))\b/i;

/** The safety nets applied to the model's pick: wording the model often mixes up is corrected in code. Pure, so the model comparison scores what the app really does. */
export function correctRoute(text: string, route: Route): Route {
  // "Add dinner with Laura saturday 8pm at Casa Pepe": a calendar entry with a person in it, not a message to them.
  if ((route.skill === "draft_reply" || route.skill === "reply_and_add" || route.skill === "propose_times") && ADD_EVENT_SHAPE.test(text) && WHEN_GIVEN.test(text) && !/\b(?:reply|answer|respond|tell|let .{1,30} know|e-?mail|message|text|write|confirm|accept|decline)\b/i.test(text)) return { skill: "add_event", args: {} };
  // "Add dentist follow-up in two weeks at 10": "add" with a day or time and no reminder word is an event, not a to-do.
  if (route.skill === "reminder" && ADD_EVENT_SHAPE.test(text) && WHEN_GIVEN.test(text) && !/\b(?:remind\w*|to-?dos?|tasks?|don'?t let me forget)\b/i.test(text)) return { skill: "add_event", args: {} };
  // "Remind me the day before my flight to check in": a request that starts with "remind me" is a reminder for the user.
  if ((route.skill === "event_from_email" || route.skill === "add_event" || route.skill === "add_flights") && /^\s*(?:please\s+)?(?:can you\s+)?remind me\b/i.test(text) && !TO_CALENDAR.test(text)) return { skill: "reminder", args: {} };
  // "What grammar am I working on in spanish": a question about the user themselves is in their notes, not on the web.
  // Not how-to or travel questions ("how do I renew my passport", "how far is my hotel from the airport"): the web answers those.
  if (route.skill === "web_search" && /\b(?:am i|do i|did i|have i|was i|i'?m|i am|i was|my)\b/i.test(text) && !/\b(?:weather|news|price|prices|score|result|results|open|opening|hours|near me|nearby|calendar|agenda|remind\w*|far|distance|route|directions?|airport|station|hotel|address)\b|^\s*how (?:do|can|should|would) i\b|\bhow to\b/i.test(text)) return { skill: "notes_search", args: { query: searchWords(text) } };
  // "Add the book club for next friday at 7pm": a day and a clock time are given, so it is a new event, not one to find in the mail.
  if (route.skill === "event_from_email" && !MAIL_WORD.test(text) && WHEN_GIVEN.test(text) && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\bat \d{1,2}\b/i.test(text)) return { skill: "add_event", args: {} };
  // "Do I have plans on saturday": the calendar (and what the mail says about that day), not who owes a reply.
  if (route.skill === "waiting_on" && /\b(?:plans?|planned|busy|free)\b/i.test(text) && !/\b(?:answer|answered|repl(?:y|ied)|got back|owe)\b/i.test(text)) return { skill: "agenda", args: {} };
  // "Give me a quick rundown of tomorrow": that day's calendar, not the morning briefing or meeting briefs.
  if (["prep_day", "briefing", "weekly_review"].includes(route.skill) && /\b(?:rundown|run-?through|overview|summary|summari[sz]e|recap)\b/i.test(text) && /\b(?:today|tomorrow|tonight|my day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text) && !/\b(?:meetings?|prep\w*|brief\w*|news|mail|emails?|inbox)\b/i.test(text)) return { skill: "agenda", args: {} };
  // "How many nights is the alfama booking": a question, not "add it to my calendar" (no add or calendar word).
  // (When, where and what-time questions are left to the calendar nets below.)
  if (route.skill === "event_from_email" && /^\s*(?:how (?:many|much|long)|what(?!\s+time)|which|who|is|are|do|does|did|has|have)\b/i.test(text) && !/\b(?:add|put|save|create|schedule|calendar|agenda)\b/i.test(text)) return TRAVEL_WORD.test(text) ? { skill: "trips", args: {} } : { skill: "email_question", args: route.args.query ? { query: route.args.query } : {} };
  // "What should I bring on the hike" (the model: a reply to Maria): a question about the mail, not something to write.
  if (route.skill === "draft_reply" && /^\s*(?:what|when|where|which|who|how|should i|do i|did|does|is|are)\b/i.test(text) && !/\b(?:reply|replies|answer|respond|write|tell|say|let .{1,30} know|e-?mail (?:him|her|them|back)|draft|confirm|accept|decline)\b/i.test(text)) return { skill: "email_question", args: route.args.who ? { query: `from:${route.args.who}` } : {} };
  // "What bills do I have coming up": money owed is in the mail, not the calendar.
  // Also when the model said inbox review, waiting on or weekly review: "coming up" would then send it to the calendar.
  if (["agenda", "priorities", "inbox_review", "waiting_on", "weekly_review"].includes(route.skill) && /\b(?:bills?|invoices?|payments?|owe|to pay|renewals?)\b/i.test(text) && !/\b(?:repl(?:y|ies)|answers?|respon[ds]\w*|got back)\b/i.test(text) && !/\b(?:calendar|agenda|meetings?|events?|appointments?)\b/i.test(text)) return { skill: "email_question", args: { query: "(bill OR invoice OR payment OR renewal OR renews OR due)" } };
  // "What's left today": the rest of the calendar, not the priorities list.
  if (route.skill === "priorities" && /\b(?:left|remaining|rest of)\b/i.test(text) && !/\b(?:to-?dos?|tasks?|reminders?)\b/i.test(text)) return { skill: "agenda", args: {} };
  // "What's the kitchen budget": subscriptions are only what the user pays for regularly or gets as newsletters.
  if (route.skill === "subscriptions" && !/\b(?:subscri\w*|newsletters?|unsubscribe|monthly|every month|regularly|recurring|pay(?:ing)? for)\b/i.test(text)) return { skill: "notes_search", args: { query: searchWords(text) } };
  // The model sometimes over-picks a chain: without its second half in the request, it's the plain skill.
  const someoneElse = SELF_REMINDER.test(text) ? null : text.match(/\b(?:send (?:a )?(?:reminder|nudge) to|remind|chase)\s+(?!me\b|myself\b)([A-Z][\p{L}'-]+)/u);
  if ((route.skill === "reminder_from_email" || route.skill === "reminder") && someoneElse) route = { skill: "nudge", args: { who: someoneElse[1] } };
  else if (route.skill === "reminder_from_email" && !MAIL_WORD.test(text) && !/\b(bills?|invoices?|renewal|renew|expires?|deadline|due|payment)\b/i.test(text)) route = { skill: "reminder", args: {} };
  else if (route.skill === "reply_and_add" && !TO_CALENDAR.test(text) && !/\b(calendar|agenda|schedule)\b/i.test(text)) route = { skill: "draft_reply", args: route.args };
  // "Check my mail for X and set a reminder two weeks before it renews": the model picks the search half; it is one chain.
  if ((route.skill === "email_search" || route.skill === "email_question") && MAIL_WORD.test(text) && /\b(?:set|add|create|make)\s+(?:me\s+)?(?:a\s+)?(?:reminder|to-?do)\b|\bremind me\b/i.test(text)) {
    route = { skill: "reminder_from_email", args: { query: route.args.query } };
  }
  // "What do I have to do this weekend": a period was asked about, so it is the calendar, not the priorities list.
  if (route.skill === "priorities" && /\b(weekend|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|tonight)\b/i.test(text)) route = { skill: "agenda", args: {} };
  // "Is there a Spanish thing coming up": a vague event question, not travel (trips need a travel word or a place to go).
  if (route.skill === "trips" && /\b(thing|event|class|lesson|meeting|appointment|session|anything|something)\b/i.test(text) && !/\b(flights?|trips?|travel(?:ling)?|hotels?|bookings?|fly|plane|airport|journey|holiday|vacation|stay|reservations?|tickets?|train)\b/i.test(text)) route = { skill: "agenda", args: {} };
  // A question is not a reminder ("do I have to pay anything soon").
  if (route.skill === "reminder" && /^\s*(?:do|does|did|is|are|was|were|will|what|when|how|who|which|where|why|can|could|should|have|has)\b/i.test(text) && !/\b(remind|reminder|to-?do)\b/i.test(text)) {
    route = { skill: "email_question", args: { query: /\b(pay|bill|bills|owe|due)\b/i.test(text) ? "(bill OR invoice OR payment OR renewal OR renews OR due)" : route.args.query } };
  }
  // "How much does my car insurance renewal cost": a question about what a mail says, not a list of mails.
  if (route.skill === "email_search" && (/^\s*(?:how much|how many|when|what time|what(?:'s| is| was)|which|where)\b/i.test(text) || /\b(?:tell me|let me know)\s+(?:what|how much|how many|when|where|who|if)\b/i.test(text))) route = { skill: "email_question", args: { query: route.args.query } };
  // "Who's coming to the committee tonight": about an event, not about who owes a reply.
  if (route.skill === "waiting_on" && !/^\s*(?:when|what time|where)\b/i.test(text) && /\b(coming|tonight|tomorrow|meeting|committee|event|party|dinner|lunch|class)\b/i.test(text) && !/\b(answer|answered|repl(?:y|ied)|got back|owe)\b/i.test(text)) route = { skill: "agenda", args: {} };
  // "Who did I last hear from": the newest mail, not the people who owe a reply.
  if (route.skill === "waiting_on" && /\b(?:last|latest|most recent(?:ly)?|recently)\b.*\b(?:hear|heard|email(?:ed)?|wrote|written|message[sd]?)\b|\b(?:hear|heard)\b.*\b(?:last|latest)\b/i.test(text)) route = { skill: "email_search", args: { query: "in:inbox", days: 7 } };
  // "What time is lunch with Sam and where": a question about the calendar, not a search of the mail for an event to add.
  if (route.skill === "event_from_email" && /^\s*(?:what time|when|where)\b/i.test(text) && !TO_CALENDAR.test(text) && !MAIL_WORD.test(text)) route = { skill: "agenda", args: {} };
  // "How many km is my long run on sunday": a day was named and no note was mentioned: the calendar.
  if (route.skill === "notes_search" && /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|weekend)\b/i.test(text) && !/\b(notes?|wrote|written|plan|planned|goal|list)\b/i.test(text)) route = { skill: "agenda", args: {} };
  // "What do I owe on the car insurance": money and dates come from the mail first, unless the notes were named.
  if (route.skill === "notes_search" && /\b(owe|cost|costs|price|amount|bill|invoice|renew\w*|due|pay|paid|charge[sd]?)\b/i.test(text) && !/\b(notes?|wrote|written)\b/i.test(text)) route = { skill: "email_question", args: { query: route.args.query } };
  // "When's the boiler guy coming": a question about something in the mail, not the list of people who owe a reply.
  if (route.skill === "waiting_on" && /^\s*(?:when|what time|where)\b/i.test(text)) route = { skill: "email_question", args: { query: route.args.query } };
  // "Schedule a call with Jordan friday 4pm": a clock time was given, so it is an event, not a choice of slots.
  if (route.skill === "propose_times" && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:at|à)\s+\d{1,2}\b|\bnoon\b|\bmidday\b/i.test(text)) route = { skill: "add_event", args: {} };
  // "What's the capital of Australia": a general question the web answers; "I can't" is wrong when web search exists.
  if (route.skill === "unsupported" && /^\s*(?:what(?:'s| is| are| was| were)|who(?:'s| is| was| were)|when (?:is|was|did)|where (?:is|are)|how (?:many|much|far|tall|old|long|big))\b/i.test(text) && !/\b(my|me|mine|our|i)\b/i.test(text)) route = { skill: "web_search", args: { query: text } };
  // "What should I reply to the landlord": one draft to that person, not the sweep over every unanswered mail.
  const replyTo = text.match(/\bwhat (?:should|do|can) i (?:reply|answer|say|write)(?: back)? to (?:the\s+)?([\p{L}][\p{L}'-]+)/iu);
  if (route.skill === "followups" && replyTo) route = { skill: "draft_reply", args: { who: replyTo[1] } };
  // "Remind me to check in the day before": that is the flight, handled by the plain reminder (it finds the next flight).
  if (route.skill === "reminder_from_email" && (/\bcheck[- ]?in\b/i.test(text) || /\b(?:my|the)\s+(?:next\s+)?(?:flight|trip)\b/i.test(text)) && !MAIL_WORD.test(text)) route = { skill: "reminder", args: {} };
  // "When does my Lisbon hotel start": bookings and flights, not the calendar.
  if (route.skill === "agenda" && /\b(hotel|stay|flights?|booking|trip|check-?in|check-?out)\b/i.test(text) && !/\b(calendar|agenda|schedule)\b/i.test(text)) route = { skill: "trips", args: {} };
  // "Is there anything I forgot to answer": mail the user owes a reply to, not people who owe the user.
  if (route.skill === "waiting_on" && /\b(?:i|me)\b.*\b(?:forgot|forget|need|have|should|must|haven'?t|didn'?t|still)\b.*\b(?:answer|reply|respond)/i.test(text)) route = { skill: "inbox_review", args: { days: 7 } };
  // "How's my week shaping up": what's coming, not the review of the week past.
  if (route.skill === "weekly_review" && /\b(shaping up|looking like|look like|ahead|coming up|look(?:s|ing)? (?:busy|full))\b/i.test(text)) route = { skill: "agenda", args: {} };
  // "Remind me about the boiler inspection the day before": the day comes from the mail, so look it up.
  if (route.skill === "reminder" && RELATIVE_BEFORE.test(text) && !/\bcheck[- ]?in\b|\b(?:my|the)\s+(?:next\s+)?(?:flight|trip)\b/i.test(text) && !/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/.-]\d{1,2}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d)\b/i.test(text)) {
    route = { skill: "reminder_from_email", args: { query: text.replace(/^\s*(?:please\s+)?remind me\s+(?:about|to|that|of)\s+/i, "").replace(RELATIVE_BEFORE, "").replace(/^\s*(?:the|my|a|an)\s+/i, "").replace(/\s+/g, " ").trim() } };
  }
  // A question about what's coming up is a calendar question, not a 7-minute email review.
  if (route.skill === "inbox_review" && !MAIL_WORD.test(text) && /\b(coming up|on my plate|schedule|calendar|meetings?|appointments?|events?|agenda)\b/i.test(text)) route = { skill: "agenda", args: {} };
  // A question ("what is it?") is not a request to set a reminder.
  else if (route.skill === "reminder_from_email" && !/\b(remind|reminder|don'?t let me forget|before (?:it'?s|they'?re) due|alert me)\b/i.test(text)) route = { skill: "email_question", args: { query: route.args.query } };
  // "My next flight and the weather there": the trip's forecast (it names the flight too).
  if (route.skill === "trips" && /\b(weather|forecast|rain|temperature)\b/i.test(text)) route = { skill: "trip_weather", args: {} };
  return route;
}

/** The safety nets after a pick: the model's (or a quick rule's) route, corrected where wording shows it misread. */
async function settleRoute(ctx: Ctx, text: string, route: Route): Promise<Route> {
  route = correctRoute(text, route);
  // Before "I can't do that": a note may cover it ("how much is left of the kitchen budget if I go with quote B").
  // Not over a deliberate quick-rule refusal ("move my long run": the app can't move events), nor for things to do.
  const ACTION_VERB = /\b(buy|order|purchase|book|pay|call|phone|translate|delete|remove|forward|send|play|turn on|turn off|move|reschedule|cancel|postpone|change|edit)\b/i;
  if (route.skill === "unsupported" && quickRoute(text)?.skill !== "unsupported" && !ACTION_VERB.test(text) && (await notesLikely(ctx, text))) route = { skill: "notes_search", args: { query: text } };
  // "What's the latest on the kitchen", "is the kitchen budget enough": no mail word, and a note is about it: the notes.
  // "Is the kitchen quote from Priya in yet", "has Tom sent the photos": a person the user waits on: the mail and the tracked wait.
  if (["notes_search", "unsupported", "agenda"].includes(route.skill) && /\b(yet|answered|repl(?:y|ied)|got back|sent|in yet|arrived)\b/i.test(text)) {
    const waits = all<{ recipient: string }>(ctx.db, `SELECT recipient FROM waiting_on WHERE 1 = 1${demoRowsFilter()}`);
    const who = waits.map((w) => w.recipient.replace(/\s*<[^>]*>/, "").split(/\s+/)[0]).find((n) => n.length > 2 && new RegExp(`\\b${n}\\b`, "i").test(text));
    if (who) route = { skill: "email_question", args: { query: `from:${who}` } };
  }
  // A mail search needs two words of a note's title ("kitchen" and "quote"): "renew something soon" stays a mail question.
  if (!MAIL_WORD.test(text) && ((route.skill === "inbox_review" && (await notesLikely(ctx, text))) || (["email_search", "email_question"].includes(route.skill) && (await notesLikely(ctx, text, 2))))) route = { skill: "notes_search", args: { query: text } };
  // "Where do I drop off my bike", "how long does the garden committee go on for": a question about an event in the calendar
  // is the calendar's, whichever of trips, notes or mail the model picked.
  // Over notes or mail, every word must be the event's ("how long is my spanish streak" stays a note); over trips (never
  // right without a travel word) the usual match is enough.
  if (["trips", "notes_search", "email_question", "email_search"].includes(route.skill) && !TO_CALENDAR.test(text) && !/\b(remind|reminder|flights?|hotels?|bookings?|e-?mails?|mail|inbox|notes?)\b/i.test(text) && (await namedEventAnswer(ctx, text, route.skill !== "trips"))) route = { skill: "agenda", args: {} };
  // "Add the school concert on november 12 at 6:30pm": the request gives the day and the time, so it's the user's own event,
  // not one to look up on the web (which found another school's concert).
  if (route.skill === "event_from_web" && !/\b(?:web|online|internet|look (?:it )?up|search|find|official|public)\b/i.test(text) && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i.test(text)) {
    const p = parseEventRequest(eventText(text), ctx.now(), config().timezone);
    if (!("error" in p) && !p.allDay) route = { skill: "add_event", args: {} };
  }
  // Trips answer only about travel: "which route is maria planning" has no travel word and names nothing booked, so it's a
  // question for the mail (the trips list was shown for anything the model couldn't place).
  if (route.skill === "trips" && !TRAVEL_WORD.test(text)) {
    const booked = new Set(all<{ subject: string }>(ctx.db, `SELECT subject FROM bookings WHERE 1 = 1${demoRowsFilter()}`).flatMap((b) => b.subject.toLowerCase().match(/\p{L}{4,}/gu) ?? []));
    if (!(text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).some((w) => booked.has(w))) route = { skill: "email_question", args: { query: searchWords(text) } };
  }
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
  return route;
}

/** Runs one skill. `chosen`: the user picked it themselves ("not right?"), so the nets don't second-guess it. */
async function runSkill(ctx: Ctx, text: string, route: Route, workflows: WorkflowRegistry, chosen = false): Promise<CommandResult> {
  if (!chosen) route = await settleRoute(ctx, text, route);
  const a = route.args;
  const answer = (intent: Intent, r: SkillAnswer): CommandResult => ({ intent, reply: r.reply, items: r.items, section: r.section, ref: r.actionId ? { actionId: r.actionId } : undefined });
  const later = (intent: Intent, reply: string, work: NonNullable<CommandResult["background"]>): CommandResult => ({ intent, reply, background: work, section: "today" });
  switch (route.skill) {
    case "inbox_review": {
      const days = Math.min(Math.max(a.days ?? (/\bmonth\b/i.test(text) ? 30 : /\b(two|2) weeks\b/i.test(text) ? 14 : 7), 1), 30);
      if (!isConnected(ctx, "gmail")) return { intent: "inbox_review", reply: "Gmail isn't connected, so I can't read your email. Connect it in Connections & Permissions.", section: "permissions" };
      const spam = /\b(spam|junk)\b/i.test(text);
      return later("inbox_review", `On it: I'm reading your ${spam ? "spam folder" : "email"} from the last ${days} days with the local model, one message at a time. This takes a few minutes; the answer will appear under “Your requests” on Today, and you'll get a notification if they're on.`, async (p) => {
        const out = await reviewInbox(ctx, days, p, undefined, 30, spam ? "in:spam" : "in:inbox");
        // "…then draft replies to anything urgent": the review is done, the drafts are asked for one by one.
        return /\b(draft|reply|replies|respond|answer)\b/i.test(text) ? { ...out, reply: `${out.reply} I only reviewed your mail: I don't write replies for a whole list on my own. Tell me which one, e.g. “reply to <name> that …”.` } : out;
      });
    }
    case "email_question": {
      const query = a.query?.trim() || searchWords(text) || text;
      return later("email_question", "Looking through your mail for the answer with the local model. It will appear under “Your requests” on Today.", async (p) => {
        const mail = await emailQuestion(ctx, text, query, p);
        // "How long would quote A take": no email about it, but a note is: the notes answer (the mail wasn't named).
        if (/^I found no email matching/.test(mail.reply) && !MAIL_WORD.test(text) && (await notesLikely(ctx, text))) return notesAnswer(ctx, text, p);
        return mail;
      });
    }
    case "meeting_prep": {
      const who = a.who?.trim() || a.query?.trim() || text;
      return later("meeting_prep", `Preparing a brief for “${who}” from your calendar, recent emails and notes. It will appear under “Your requests” on Today.`, (p) => meetingPrep(ctx, text, who, p));
    }
    case "weather":
      return answer("weather", await weatherAnswer(ctx, text, a.query?.trim() || null));
    case "email_search": {
      // "Who emailed me today": the newest mail of that period, not a search for those words.
      const who = !a.query?.trim() && /^\s*who\s+(?:has\s+)?(?:e-?mailed|emailed|wrote|written|mailed|messaged|sent)\b/i.test(text);
      const days = a.days ?? (who ? (/\btoday\b/i.test(text) ? 1 : /\bweek\b/i.test(text) ? 7 : 3) : undefined);
      return answer("email_search", await emailSearch(ctx, who ? "in:inbox" : a.query?.trim() || searchWords(text) || text, days));
    }
    case "agenda":
      return answer("agenda", await agenda(ctx, text));
    case "add_event":
      return runIntent(ctx, text, { intent: "event", query: eventText(text) }, workflows);
    case "add_flights":
      return runIntent(ctx, text, { intent: "flights" }, workflows);
    case "reminder_from_email": {
      const query = a.query?.trim() || text;
      // "Remind me the day before my dentist appointment": an event in the calendar gives the day before the mail is searched.
      if (RELATIVE_BEFORE.test(text)) {
        const fromCalendar = await reminderBeforeEvent(ctx, text, query);
        if (fromCalendar) return answer("reminder", fromCalendar);
      }
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
      // The writer gets the user's own request, not the model's paraphrase of it (as for draft_reply).
      const message = text;
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
      // "Remind me to check in the day before": the next flight gives the day.
      if ((/\bcheck[- ]?in\b/i.test(text) || (RELATIVE_BEFORE.test(text) && /\b(?:my|the)\s+(?:next\s+)?(?:flight|trip)\b/i.test(text))) && !/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(text)) {
        const flight = checkInReminder(ctx, text);
        if (flight) return answer("reminder", flight);
      }
      // "Remind me the morning of the boiler inspection to…", "…before the committee to…": placed relative to that event.
      if (!/\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm)|in \d+ (?:minutes?|hours?|days?))\b/i.test(text)) {
        const anchored = await reminderAtEvent(ctx, text);
        if (anchored) return answer("reminder", anchored);
      }
      // "Send a reminder to Tom…", "remind Laura…" are about someone else: a nudge, not a to-do for the user.
      const other = SELF_REMINDER.test(text) ? null : text.match(/\b(?:send (?:a )?(?:reminder|nudge) to|remind|chase)\s+(?!me\b|myself\b)([A-Z][\p{L}'-]+)/u);
      if (other) return answer("nudge", await nudge(ctx, other[1]));
      return answer("reminder", reminderFromText(ctx, text));
    }
    case "draft_reply": {
      // "tell the landlord tuesday morning works": the model sometimes leaves out who; the wording names them.
      const named = text.match(/\b(?:tell|ask|reply to|answer|write (?:back )?to|e-?mail|message|text|let)\s+(?:the\s+)?(?!me\b|him\b|her\b|them\b|everyone\b)([\p{L}][\p{L}'-]{1,30})/iu)?.[1];
      if (!a.who && !named) return { intent: "help", asked: true, reply: "Who should I reply to? Say for example “reply to Ana that Thursday works”." };
      const who = a.who || named!;
      // A vague mention of a person ("that thing from Laura") isn't a request to write to them: ask what is wanted.
      if (!/\b(reply|replies|answer|respond|write|tell|say|ask|let .{1,30} know|e-?mail|mail|message|text|confirm|accept|decline)\b/i.test(text)) {
        return { intent: "help", asked: true, reply: `What would you like me to do about ${who}? For example “reply to ${who} that Thursday works”, “find the email from ${who}” or “did ${who} answer?”.` };
      }
      // The writer gets the user's own request, not the model's paraphrase of it.
      const message = replyContent(text, who);
      return later("draft", `Writing a reply to ${who} with the local model. It will wait for your approval in the Action Queue; the request board shows when it's ready.`, (p) => draftReplyFree(ctx, who, message, p));
    }
    case "nudge":
      if (!a.who) return answer("waiting_on", await waitingOn(ctx));
      return answer("nudge", await nudge(ctx, a.who));
    case "waiting_on":
      return answer("waiting_on", await waitingOn(ctx));
    case "priorities":
      return answer("priorities", await priorities(ctx));
    case "reminders_list":
      return answer("reminders_list", remindersList(ctx));
    case "contact_lookup":
      return answer("contact_lookup", a.who ? contactLookup(ctx, a.who) : { reply: "Whose email address? For example “what's Priya's email?”." });
    case "trips":
      return answer("trips", await trips(ctx));
    case "subscriptions":
      return answer("subscriptions", await subscriptions(ctx));
    case "notes_search": {
      const query = a.query?.trim() || text;
      // "How much is my car insurance renewal", "when does it renew": amounts and dates come from the mail (the insurer's
      // letter) before the user's own notes, unless the notes were named. The notes answer when the mail has nothing.
      if (MONEY_OR_DATE.test(text) && !/\b(?:notes?|wrote|written|jotted)\b/i.test(text) && isConnected(ctx, "gmail")) {
        return later("notes", "Looking in your mail and your notes with the local model. The answer will appear under “Your requests” on Today.", async (p) => {
          const mail = await emailQuestion(ctx, text, searchWords(text) || query, p);
          return /^I found no email matching/.test(mail.reply) ? notesAnswer(ctx, query, p, text) : mail;
        });
      }
      return later("notes", `Looking in your notes for “${query}” and writing an answer with the local model. It will appear under “Your requests” on Today.`, (p) => notesAnswer(ctx, query, p, text));
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
      if (!a.who) return { intent: "help", asked: true, reply: "Who should I offer times to? Say for example “propose times to Ana for 30 minutes”." };
      return runIntent(ctx, text, { intent: "slots", target: a.who, query: a.minutes ? String(a.minutes) : undefined }, workflows);
    case "web_search": {
      // Search engines read questions well: the user's own words, without "search the web for".
      const query = text.replace(/^\s*(?:please\s+)?(?:(?:can|could) you\s+)?(?:search|look up|google|check)(?: (?:the web|the internet|online))?(?: for)?\s+/i, "").trim() || a.query?.trim() || text;
      return later("web_search", "Searching the web privately (your own SearXNG) and reading the top pages with the local model. The answer will appear under “Your requests” on Today.", (p) => webAnswer(ctx, text, query, p));
    }
    default:
      // Unclear, or a bare fragment with no reason given ("that thing"): a question. Something it can't do ("order pizza"): "I can't".
      if (UNCLEAR.test(a.reason ?? "") || (!a.reason && text.trim().split(/\s+/).length <= 2)) return { intent: "help", asked: true, reply: clarify(ctx, text) };
      return { intent: "unsupported", unsupported: true, reply: `I can't do that yet${a.reason ? ` (${a.reason})` : ""}. ${CAN_DO_SHORT}` };
  }
}

/** The model found the request unclear (not something the app can't do): ask, last resort. */
const UNCLEAR = /\b(vague|unclear|incomplete|ambiguous|not sure|no (?:specific )?(?:question|context|details?)|missing (?:context|details?)|too short)\b/i;

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
      const auto = await autoRun(ctx, proposed.actionId, "typed", draftFacts(ctx, text, email, name));
      if (auto.auto) return { intent, ref: { actionId: proposed.actionId }, auto: true, reply: `Done for you: a draft to ${email} is in your Gmail Drafts (never sent; you send it). Undo it under “Done for you” on Today.`, section: "today" };
      return { intent, ref: { actionId: proposed.actionId }, reply: `Proposed a Gmail draft to ${email}. Review it in the Action Queue; once approved it appears in your Gmail Drafts — it is never sent automatically.${autopilotNote(ctx, auto.why)}`, section: "actions" };
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
      // "When does the weekly review run?": answer for that task first, then list the rest.
      const asked = /\bweek/i.test(text) ? "weekly_review" : /\b(brief|morning)/i.test(text) ? "daily_briefing" : /\bfollow/i.test(text) ? "followup_sweep" : null;
      const job = asked ? jobs.find((j) => j.workflow === asked) : undefined;
      if (job) {
        const when = (j: (typeof jobs)[number]) => (j.next_run_at ? new Date(j.next_run_at).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: j.timezone }) : null);
        const next = job.status === "active" ? when(job) : null;
        return {
          intent,
          reply: next ? `“${job.name}” runs next on ${next}.` : `“${job.name}” isn't scheduled to run${job.status !== "active" ? ` (${job.status}${job.status_reason ? `: ${job.status_reason}` : ""})` : ""}. You can change that in Scheduled Agents.`,
          section: "schedules",
        };
      }
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
      return proposeSlots(ctx, target!, query ? Number(query) : 30, /\bnext week\b/i.test(text));
    case "remember": {
      try {
        addFact(ctx, query!);
      } catch (err) {
        return { intent, reply: err instanceof Error ? err.message : "Couldn't save that." };
      }
      return { intent, reply: `Saved to About me: “${query}”. Agents use it when writing for you; edit or remove it in Knowledge & Data.`, section: "knowledge" };
    }
    case "event": {
      // "Add the second one": the assistant doesn't remember earlier answers, and says so.
      if (/^(?:the |that |this )?(?:first|second|third|fourth|last|other|same|that|this|it)(?: one| thing| item| event)?$/i.test(query!.trim())) {
        return { intent: "help", reply: "I don't remember my earlier answers: each request stands alone. Tell me the event itself, for example “add dentist friday 3pm”." };
      }
      const prepared = parseEventRequest(query!, ctx.now(), config().timezone);
      // "Add the hike with Maria to my calendar": no date was said, so the mail may know it.
      if ("error" in prepared && /^When is it\?/.test(prepared.error) && isConnected(ctx, "gmail") && query && query.split(/\s+/).length >= 2) return runSkill(ctx, text, { skill: "event_from_email", args: { query } }, workflows);
      if ("error" in prepared) return { intent, reply: prepared.error };
      const manual = (note = "") => {
        logActivity(ctx, { actor: "calendar", kind: "agent_run", agentId: "calendar", outcome: "info", summary: `Prepared a calendar event for you to add: ${prepared.title.slice(0, 80)} (nothing written)` });
        return {
          intent,
          reply: `${/\b(every|each|weekly|daily|monthly|recurring|repeat(?:s|ing)?)\b/i.test(query ?? "") ? `I can't make repeating events, so this is a single event on ${new Date(prepared.startsAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: config().timezone })}. ` : ""}Here is the event. Check it, then add it to Google Calendar (Google opens the event pre-filled; nothing is saved until you click Save there) or download it for any calendar app.${note}`,
          event: prepared,
        };
      };
      if (calendarMode(ctx) === "link") return manual();
      const proposed = await proposeEvent(ctx, prepared);
      if ("approval" in proposed) {
        // Autopilot (off unless the owner turned it on for events): an event the owner typed may be added without a click.
        const tzName = config().timezone;
        const day = localToday(new Date(prepared.startsAt), tzName);
        const sameDay = await eventsBetween(ctx, zonedToUtc(day, 0, tzName), zonedToUtc(day, 24 * 60, tzName)).catch(() => null);
        const auto = await autoRun(ctx, proposed.approval.actionId, "typed", eventFacts(text, prepared.startsAt, prepared.endsAt, sameDay && "events" in sameDay ? sameDay.events.length : 99));
        if (auto.auto) return { intent, ref: { actionId: proposed.approval.actionId }, event: prepared, auto: true, reply: `Done for you: added to your “${proposed.approval.calendar}” calendar. Undo it under “Done for you” on Today.`, section: "today" };
        return { intent, ref: { actionId: proposed.approval.actionId }, event: prepared, approval: proposed.approval, reply: `Ready to add to your “${proposed.approval.calendar}” calendar. Approve it here or in the Action Queue.${autopilotNote(ctx, auto.why)}` };
      }
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
          reply: "I can add one event at a time (“add event: dentist tuesday 3pm”, or in French “rdv : dîner vendredi 20h”) or the flights from your booking emails (“add my flights to my calendar”). Each one waits for your click.",
        };
      }
      return { intent: "help", reply: HELP };
  }
}
