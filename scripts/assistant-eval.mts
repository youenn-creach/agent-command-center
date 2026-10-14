import "./_env.mts";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "@/server/db";
import { quickRoute, routeRequest, type Skill } from "@/server/agents/assistant";
import { classify } from "@/server/agents/command";

/**
 * How well the Chief of Staff understands everyday requests, measured with the real local model:
 * each request must land on the right skill (some accept two). Run on a throwaway data folder:
 *   ACC_DATA_DIR=.e2e-data/eval-assistant npx tsx scripts/assistant-eval.mts
 * Requests that have an exact form ("add event: …") skip the model in the app and are marked as such.
 */

const CASES: [string, Skill | Skill[]][] = [
  // Email: what needs me
  ["from my emails over the past week, is there any particular action required of me that i should look into?", "inbox_review"],
  ["did I miss anything important in my inbox?", "inbox_review"],
  ["any bills I need to pay?", "inbox_review"],
  ["what emails do I need to answer?", "inbox_review"],
  ["is there anything urgent in my email?", "inbox_review"],
  ["summarize my emails from today", "inbox_review"],
  ["go through my inbox and tell me what needs my attention", "inbox_review"],
  ["do I have any deadlines coming up in my emails?", "inbox_review"],
  ["what did I get in my email this week that I should care about?", "inbox_review"],
  ["any documents I need to sign?", "inbox_review"],
  // Email: find something
  ["did Marc answer my email about the apartment?", ["email_search", "email_question"]],
  ["find the email from Booking.com about Lisbon", "email_search"],
  ["show me emails from my bank this month", "email_search"],
  ["has the landlord written back?", ["email_search", "email_question"]],
  ["where's the invoice from Amazon?", "email_search"],
  ["did I get my plane tickets by email?", ["email_search", "email_question", "trips"]],
  ["what did Laura say about Saturday?", ["email_search", "email_question"]],
  ["find emails about the job interview", "email_search"],
  // Calendar
  ["what's on my calendar tomorrow?", "agenda"],
  ["am I free next friday afternoon?", "agenda"],
  ["what do I have this weekend?", "agenda"],
  ["what's my schedule today?", "agenda"],
  ["do I have any meetings next week?", "agenda"],
  ["when is my next dentist appointment?", "agenda"],
  ["what am I doing on 20 December?", "agenda"],
  ["how busy am I this week?", "agenda"],
  // Add to calendar
  ["put dinner with Laura on saturday at 8pm in my calendar", "add_event"],
  ["schedule a call with the bank on monday at 10", "add_event"],
  ["block thursday afternoon for focus work", "add_event"],
  ["add the yoga class every tuesday at 7pm", "add_event"],
  ["check my emails, and add any booked flight that you see in there into my calendar as an event", "add_flights"],
  ["put my flights in my calendar", "add_flights"],
  // Find an event in the mail and add it (the app also corrects add_event/email_question picks for these)
  ["from my emails, check when i registered for a race, then add it to my calendar", "event_from_email"],
  ["find the concert tickets in my email and add the concert to my calendar", "event_from_email"],
  ["add my dentist appointment from the confirmation email to my calendar", "event_from_email"],
  // Reminders
  ["remind me to call mom tomorrow at 6pm", "reminder"],
  ["remind me to renew my passport next month", "reminder"],
  ["don't let me forget to buy milk", "reminder"],
  ["add a to-do: send the tax documents to the accountant", "reminder"],
  // Replies, nudges
  ["reply to Ana that Thursday works for me", "draft_reply"],
  ["answer Julien that I can't come on Friday, sorry", "draft_reply"],
  ["write back to the landlord saying the plumber can come on Monday", "draft_reply"],
  ["tell Laura yes for dinner on Saturday", "draft_reply"],
  ["follow up with Priya about the quote", "nudge"],
  ["chase the bank about my card", "nudge"],
  ["send a reminder to Tom about the photos", "nudge"],
  ["who hasn't gotten back to me?", "waiting_on"],
  ["who owes me a reply?", "waiting_on"],
  ["draft replies to my unanswered emails", "followups"],
  // Trips, subscriptions
  ["what trips do I have coming up?", "trips"],
  ["when is my next flight?", ["trips", "agenda"]],
  ["do I have any hotel bookings?", "trips"],
  ["which subscriptions am I paying for?", "subscriptions"],
  ["what newsletters am I subscribed to?", "subscriptions"],
  ["am I paying for anything I don't use?", "subscriptions"],
  // Notes
  ["what did I write about the kitchen renovation?", "notes_search"],
  ["what's my half-marathon goal time?", "notes_search"],
  ["what gift ideas did I note for my mother?", "notes_search"],
  ["how often do I feed the sourdough starter?", "notes_search"],
  // The app itself
  ["give me my morning briefing", "briefing"],
  ["brief me", "briefing"],
  ["how was my week?", "weekly_review"],
  ["do my weekly review", "weekly_review"],
  ["is anything waiting for my approval?", "pending_approvals"],
  ["what do I need to approve?", "pending_approvals"],
  ["what tasks are scheduled to run?", "schedules"],
  ["when does the briefing run?", "schedules"],
  ["remember that my partner is called Sam", "remember"],
  ["remember I prefer short replies", "remember"],
  ["find a 30 minute slot with Tom next week", "propose_times"],
  ["send Ana some times I'm free for a call", "propose_times"],
  // Not possible (yet)
  ["what's the weather in Barcelona tomorrow?", "weather"],
  ["will it rain this weekend?", "weather"],
  // From the Instinct research: answers inside emails, meeting prep, spam
  ["what's my booking reference for the Lisbon hotel?", "email_question"],
  ["how much was my last electricity bill?", "email_question"],
  ["what time does my flight to Nice leave?", ["email_question", "trips"]],
  ["prep me for my call with the accountant", "meeting_prep"],
  ["what should I know before my meeting with Laura?", "meeting_prep"],
  ["is there anything important in my spam?", "inbox_review"],
  ["find old promotional emails I could delete", "email_search"],
  // Web questions: "web search isn't available yet" or "can't do that yet" are both the honest answer.
  ["who won the champions league final?", ["web_search", "unsupported"]],
  ["what's the latest news about the election?", ["web_search", "unsupported"]],
  ["book me a table at a restaurant tonight", "unsupported"],
  ["order a pizza", "unsupported"],
  ["play some music", "unsupported"],
  ["translate this to Spanish: see you soon", "unsupported"],
];

process.env.ACC_MODE = process.env.ACC_MODE ?? "mixed";
const ctx = { db: openDb(), now: () => new Date() };
type Row = { request: string; want: string; got: string; ok: boolean; ms: number; exact: boolean; args: string };
const rows: Row[] = [];
const EXACT = new Set(["draft", "event", "remember", "slots", "automation", "flights", "refused"]);
for (const [request, want] of CASES) {
  const wanted = Array.isArray(want) ? want : [want];
  const fast = classify(request);
  const quick = quickRoute(request);
  if (quick && !EXACT.has(fast.intent)) {
    rows.push({ request, want: wanted.join("|"), got: `${quick.skill} (quick rule)`, ok: wanted.includes(quick.skill), ms: 0, exact: true, args: JSON.stringify(quick.args) });
  } else if (EXACT.has(fast.intent)) {
    const mapped = { event: "add_event", flights: "add_flights", remember: "remember", slots: "propose_times", draft: "draft_reply" }[fast.intent as string] ?? fast.intent;
    rows.push({ request, want: wanted.join("|"), got: `${mapped} (exact command)`, ok: wanted.includes(mapped as Skill), ms: 0, exact: true, args: "" });
  } else {
    const t = Date.now();
    let got = "error";
    let args = "";
    try {
      const r = await routeRequest(ctx, request);
      got = r.skill;
      args = JSON.stringify(r.args);
    } catch (err) {
      got = `error: ${err instanceof Error ? err.message.slice(0, 60) : err}`;
    }
    rows.push({ request, want: wanted.join("|"), got, ok: wanted.includes(got as Skill), ms: Date.now() - t, exact: false, args });
  }
  const r = rows.at(-1)!;
  console.log(`${r.ok ? "ok " : "BAD"} ${String(r.ms).padStart(6)}ms  ${r.want.padEnd(28)} ${r.got.padEnd(28)} ${r.args.slice(0, 60)} | ${request.slice(0, 60)}`);
}
const routed = rows.filter((r) => !r.exact);
const ok = rows.filter((r) => r.ok).length;
const avg = Math.round(routed.reduce((s, r) => s + r.ms, 0) / Math.max(1, routed.length));
console.log(`\n${ok}/${rows.length} understood correctly (${Math.round((ok / rows.length) * 100)}%); ${routed.length} went through the local model, avg ${Math.round(avg / 1000)} s each.`);
const out = path.join(process.env.ACC_DATA_DIR ?? "data", "assistant-eval.json");
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), ok, total: rows.length, avgMs: avg, rows }, null, 2));
console.log(`Saved to ${out}`);
process.exit(0);
