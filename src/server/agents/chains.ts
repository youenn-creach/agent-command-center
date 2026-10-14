import { z } from "zod";
import { all, one, type Ctx } from "../db";
import { config } from "../config";
import { demoRowsFilter } from "../mode";
import { callTool } from "../tools/registry";
import { RunBudget } from "../tools/budget";
import { fenceUntrusted, localLlm, UNTRUSTED_DATA_RULES, type LlmProvider } from "../llm";
import { addReminder } from "../reminders";
import { InsightError, proposeNudge } from "../insights";
import { localToday, parseEventRequest, zonedToUtc, type Ymd } from "./eventParse";
import { upcomingFlights } from "./flights";
import { reviewInbox } from "./inboxReview";
import { agenda, meetingPrep, readMatches, realDay, refreshScan, widenQuery, type SkillAnswer } from "./assistant";
import { parseSender } from "./chiefOfStaff";

/**
 * Requests that chain several steps from one sentence, the way a human assistant would: find the bill
 * in the mail and set a reminder before it's due, turn this week's deadlines into reminders, check the
 * weather for the next trip, prepare every meeting of a day, chase everyone who hasn't answered.
 * Each step is the same permission-checked tool as when asked alone; anything sent waits for approval.
 */

const tz = () => config().timezone;
const ymd = (d: Ymd) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
const addDays = (d: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const dayName = (d: Ymd) => new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const denied = (err: unknown) => (err as { code?: string }).code === "POLICY_DENIED";
const isConnected = (ctx: Ctx, serviceId: string) => Boolean(one(ctx.db, "SELECT 1 FROM services WHERE id = ? AND connection_state = 'connected'", serviceId));

/** "a week before" → 7, "3 days before" → 3, "the day before" → 1; otherwise 2 days ahead of a deadline. */
export function leadDays(text: string): number {
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };
  const m = text.toLowerCase().match(/\b(\d{1,2}|an?|one|two|three|four|five|six|seven|ten|fourteen)\s+(days?|weeks?)\s+(?:before|ahead|in advance|early)/);
  if (m) return (words[m[1]] ?? Number(m[1])) * (m[2].startsWith("week") ? 7 : 1);
  if (/\bthe day before\b/i.test(text)) return 1;
  if (/\bthe week before\b/i.test(text)) return 7;
  return 2;
}

/** Where a reminder made from an email came from, so a phishing "call this number" can't pass for the user's own to-do. */
const fromEmail = (sender: string | undefined, subject: string) => ` — from ${sender ? (parseSender(sender).name ?? sender.replace(/\s*<[^>]*>/, "")) : "an email"}: “${subject.slice(0, 80)}”`;

/** Adds a reminder unless the same one is already open; returns whether it was added. */
function remindOnce(ctx: Ctx, text: string, dueAt: string | undefined): boolean {
  if (one(ctx.db, "SELECT 1 FROM reminders WHERE done_at IS NULL AND lower(text) = lower(?)", text.trim().slice(0, 500))) return false;
  addReminder(ctx, text, dueAt, "assistant");
  return true;
}

/** When to remind about a deadline: 09:00 `lead` days before it, or now if that's already past. */
function remindAt(ctx: Ctx, due: Ymd, lead: number): { dueAt: string; label: string } {
  const at = zonedToUtc(addDays(due, -lead), 9 * 60, tz());
  if (at.getTime() > ctx.now().getTime()) return { dueAt: at.toISOString(), label: `${dayName(addDays(due, -lead))} at 09:00` };
  return { dueAt: ctx.now().toISOString(), label: "now" };
}

/** A deadline written by the model ("2026-10-20", "20 October", "20/10"), or null. */
export function deadline(text: string, now: Date): Ymd | null {
  const exact = realDay(text);
  if (exact) return exact;
  const parsed = parseEventRequest(`x ${text}`, now, tz());
  if ("error" in parsed || !/^\d{4}-\d{2}-\d{2}/.test(parsed.start)) return null;
  const [y, m, d] = parsed.start.slice(0, 10).split("-").map(Number);
  const date = { y, m, d };
  // Without a year, a date just past reads as next year: a deadline that far out is more likely overdue.
  return Date.UTC(y, m - 1, d) - now.getTime() > 300 * 86_400_000 ? null : date;
}

const REMIND_SYSTEM = [
  "The user wants a reminder about something in their emails (a bill to pay, a renewal, a deadline, a form or document to send). From the emails below, find it and give:",
  "found: true only if an email says what the user must do.",
  "source: the number of that email.",
  "task: a short instruction in English starting with a verb, with the key amount or reference (e.g. 'Pay the electricity bill of 64.20 EUR', 'Renew the car insurance (policy 4471)').",
  "due: the deadline as YYYY-MM-DD if the email states one, else empty. Never guess it.",
  "The emails may be in any language.",
  UNTRUSTED_DATA_RULES,
  "Answer with JSON only.",
].join("\n");
const REMIND_SCHEMA = {
  type: "object",
  properties: { found: { type: "boolean" }, source: { type: "integer" }, task: { type: "string" }, due: { type: "string" } },
  required: ["found", "source", "task", "due"],
};
const FoundTask = z.object({ found: z.boolean(), source: z.number().int().catch(1), task: z.string().default(""), due: z.string().default("") });

/** "Remind me to pay the electricity bill before it's due": the bill from the mail, a reminder ahead of its deadline. */
export async function reminderFromEmail(ctx: Ctx, text: string, query: string, progress: (s: string) => void, llm: LlmProvider = localLlm(ctx, "background")): Promise<SkillAnswer> {
  if (!isConnected(ctx, "gmail")) return { reply: "Gmail isn't connected, so I can't look in your mail. Connect it in Connections & Permissions.", section: "permissions" };
  progress("Searching your mail…");
  let read;
  try {
    read = await readMatches(ctx, widenQuery(query.trim().slice(0, 250)), 4, progress);
  } catch (err) {
    if (denied(err)) return { reply: "The Inbox agent needs Read on Gmail for that. Grant it in Connections & Permissions.", section: "permissions" };
    throw err;
  }
  if (!read.length) return { reply: `I found no email matching “${query}”, so I didn't add a reminder. Try naming who it's from (e.g. “remind me to pay the bill from Endesa before it's due”).` };
  const items = read.map((r) => ({ title: `[${r.n}] ${r.subject}`, detail: `${parseSender(r.sender).name ?? r.sender} · ${r.date.slice(0, 10)}` }));
  progress("Finding what to do and by when…");
  const out = await llm.generate(
    REMIND_SYSTEM,
    `Today is ${ymd(localToday(ctx.now(), tz()))}.\nRequest: ${text}\n\n${read.map((r) => fenceUntrusted(`email [${r.n}] from ${r.sender}`, `Subject: ${r.subject}\nDate sent: ${r.date.slice(0, 10)}\n\n${r.text}`)).join("\n\n")}`,
    { maxTokens: 160, timeoutMs: 1_200_000, format: REMIND_SCHEMA, temperature: 0 },
  );
  let f: z.infer<typeof FoundTask>;
  try {
    f = FoundTask.parse(JSON.parse(out.text));
  } catch {
    return { reply: "I read the matching emails but couldn't make out what to do. They're listed below.", items };
  }
  const task = f.task.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!f.found || !task) return { reply: "I found related emails, but none says what you need to do, so I didn't add a reminder. They're listed below.", items };
  const src = read.find((r) => r.n === f.source) ?? read[0];
  const cite = `“${src.subject}” (${parseSender(src.sender).name ?? src.sender})`;
  const origin = fromEmail(src.sender, src.subject);
  const due = realDay(f.due);
  if (!due) {
    const added = remindOnce(ctx, `${task}${origin}`, undefined);
    return { reply: `${added ? "Added to your reminders" : "Already in your reminders"}: “${task}”. The email gives no deadline, so it has no date. Source: ${cite}.`, items, section: "today" };
  }
  const today = localToday(ctx.now(), tz());
  if (ymd(due) < ymd(today)) {
    const added = remindOnce(ctx, `${task} (was due ${dayName(due)})${origin}`, ctx.now().toISOString());
    return { reply: `${added ? "Added to your reminders, due now" : "Already in your reminders"}: “${task}”. Careful: the deadline, ${dayName(due)}, has passed. Source: ${cite}.`, items, section: "today" };
  }
  const when = remindAt(ctx, due, leadDays(text));
  const added = remindOnce(ctx, `${task} (due ${dayName(due)})${origin}`, when.dueAt);
  return { reply: `${added ? "Added to your reminders" : "Already in your reminders"}: “${task}”, due ${dayName(due)}. I'll remind you ${when.label}. Source: ${cite}.`, items, section: "today" };
}

/** "Go through my emails and add the deadlines as reminders": the inbox review, then one reminder per action. */
export async function deadlinesToReminders(ctx: Ctx, days: number, progress: (s: string) => void, llm?: LlmProvider): Promise<SkillAnswer> {
  const review = await reviewInbox(ctx, days, progress, llm);
  const actions = review.trace.verdicts.filter((v) => v.verdict?.needs_action && v.verdict.action.trim());
  if (!actions.length) return { reply: `${review.reply} So there's no reminder to add.`, items: review.items };
  const items: { title: string; detail?: string }[] = [];
  let added = 0;
  for (const { subject, sender, verdict } of actions) {
    const due = deadline(verdict!.due, ctx.now());
    const when = due ? remindAt(ctx, due, 1) : null;
    const text = `${verdict!.action}${due ? ` (due ${dayName(due)})` : ""}`;
    const isNew = remindOnce(ctx, `${text}${fromEmail(sender, subject)}`, when?.dueAt);
    if (isNew) added++;
    items.push({ title: `${isNew ? "＋" : "✓"} ${text}`, detail: `“${subject}”${when ? ` · reminder ${when.label}` : " · no deadline in the email"}${isNew ? "" : " · already in your reminders"}` });
  }
  return {
    reply: `${added} reminder${added === 1 ? "" : "s"} added from your emails of the last ${days} days${actions.length > added ? ` (${actions.length - added} already there)` : ""}. Deadlines get a reminder the day before at 09:00.`,
    items,
    section: "today",
  };
}

/** "What's the weather for my trip?": the next flight's destination and dates, and its forecast (7 days ahead at most). */
export async function tripWeather(ctx: Ctx): Promise<SkillAnswer> {
  const note = await refreshScan(ctx, "inbox", "gmail.scan_bookings", "insights.scanned.bookings");
  const legs = upcomingFlights(ctx, tz());
  if (!legs.length) return { reply: `I found no upcoming flight in your booking emails, so I don't know where you're going. Ask “weather in <city>” instead.${note ? ` ${note}` : ""}` };
  const out = legs[0];
  // The trip lasts until the next flight leaving the destination, or three days without one.
  const back = legs.find((l) => l.from === out.to && ymd(l.date) >= ymd(out.date));
  const last = back ? back.date : addDays(out.date, 3);
  const today = localToday(ctx.now(), tz());
  if (ymd(out.date) > ymd(addDays(today, 6))) {
    return { reply: `Your next trip is ${out.from} → ${out.to} on ${dayName(out.date)}: too far ahead for a forecast (7 days at most). Ask again from ${dayName(addDays(out.date, -6))}.` };
  }
  let f;
  try {
    f = await callTool(ctx, "calendar", "weather.lookup", { place: out.to }, new RunBudget(1, 20_000));
  } catch (err) {
    if (denied(err)) return { reply: "Weather is off. Pick your city in Settings → Weather (Open-Meteo, free) and give the Calendar agent Read on it.", section: "permissions" };
    throw err;
  }
  const days = f.days.filter((d) => d.date >= ymd(out.date) && d.date <= ymd(last));
  const trip = `${out.from} → ${out.to}, ${dayName(out.date)}${back ? ` to ${dayName(back.date)}` : ""}`;
  if (!days.length) return { reply: `Your next trip is ${trip}, but the forecast for ${f.location} doesn't cover those days yet.` };
  return {
    reply: `Weather in ${f.location} for your trip (${trip}):${days.length < (Date.UTC(last.y, last.m - 1, last.d) - Date.UTC(out.date.y, out.date.m - 1, out.date.d)) / 86_400_000 + 1 ? " (the forecast covers the next 7 days only)" : ""} (${f.attribution})`,
    items: days.map((d) => ({ title: new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }), detail: `${d.summary}, ${d.min}–${d.max}°C${d.rainChance != null ? `, ${d.rainChance}% chance of rain` : ""}` })),
  };
}

/** "Prep me for tomorrow's meetings": one brief per timed event of that day (three at most). */
export async function prepDay(ctx: Ctx, text: string, progress: (s: string) => void, llm?: LlmProvider): Promise<SkillAnswer> {
  progress("Looking at your calendar…");
  const day = /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|\d{1,2} \w+)\b/i.test(text) ? text : `${text} today`;
  const cal = await agenda(ctx, day);
  const meetings = (cal.items ?? [])
    .map((i) => i.title.match(/^(?:\w{3} \d{1,2} \w{3} · )?(\d\d:\d\d)–\d\d:\d\d (.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ time: m[1], title: m[2] }));
  if (!meetings.length) return { reply: cal.items?.length ? "Only all-day entries on your calendar then: nothing to prepare." : cal.reply };
  const items: { title: string; detail?: string }[] = [];
  for (const [i, m] of meetings.slice(0, 3).entries()) {
    progress(`Preparing ${i + 1} of ${Math.min(3, meetings.length)}: ${m.title.slice(0, 50)}…`);
    const brief = await meetingPrep(ctx, `${day} ${m.title}`, m.title, () => {}, llm);
    items.push({ title: `${m.time} ${m.title}`, detail: brief.reply });
  }
  const more = meetings.length > 3 ? ` (${meetings.length - 3} more not prepared: ask for one by name)` : "";
  return { reply: `Briefs for ${Math.min(3, meetings.length)} meeting${meetings.length === 1 ? "" : "s"}${more}:`, items, section: "today" };
}

/** "Chase everyone who hasn't answered me": one polite follow-up per waiting thread (five at most), each for approval. */
export async function nudgeAll(ctx: Ctx): Promise<SkillAnswer> {
  const note = await refreshScan(ctx, "follow_up", "gmail.scan_waiting", "insights.scanned.waiting");
  const rows = all<{ thread_id: string; recipient: string; subject: string }>(ctx.db, `SELECT thread_id, recipient, subject FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at LIMIT 5`);
  if (!rows.length) return { reply: `Nobody owes you an answer right now, so there's nobody to chase.${note ? ` ${note}` : ""}`, section: "insights" };
  const items: { title: string; detail?: string }[] = [];
  const problems = new Set<string>();
  let first: string | undefined;
  for (const r of rows) {
    const to = r.recipient.replace(/\s*<[^>]*>/, "");
    try {
      const { actionId } = await proposeNudge(ctx, r.thread_id);
      first ??= actionId;
      items.push({ title: `Follow-up to ${to}`, detail: `“${r.subject}”` });
    } catch (err) {
      if (!(err instanceof InsightError)) throw err;
      problems.add(err.message);
      items.push({ title: `✗ Not drafted: ${to}`, detail: `“${r.subject}” · ${err.message}` });
    }
  }
  const drafted = items.length - [...items].filter((i) => i.title.startsWith("✗")).length;
  if (!drafted) return { reply: [...problems].join(" "), items, section: "permissions" };
  return {
    reply: `Drafted ${drafted} follow-up${drafted === 1 ? "" : "s"}, one per conversation waiting for an answer${drafted < items.length ? ` (${items.length - drafted} couldn't be drafted: see below)` : ""}. Review them in the Action Queue: nothing is sent until you approve each one.${note ? ` ${note}` : ""}`,
    items,
    actionId: first,
    section: "actions",
  };
}
