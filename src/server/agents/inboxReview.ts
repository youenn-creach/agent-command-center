import { correctWeekdayDate } from "./eventParse";
import { config } from "../config";
import { AUTOMATED } from "../connectors/google";
import { z } from "zod";
import { type Ctx } from "../db";
import { logActivity } from "../activity";
import { callTool } from "../tools/registry";
import { RunBudget } from "../tools/budget";
import { fenceUntrusted, localLlm, UNTRUSTED_DATA_RULES, type LlmProvider } from "../llm";
import { injectionFlags, isAiDirected } from "../retrieval/text";
import { parseSender } from "./chiefOfStaff";

/**
 * "Is there anything in my email this week that needs me?" The local model reads each recent email
 * (people and services; newsletters and promotions are only counted) and answers, per email, with a
 * small structured verdict: does it need the user, what to do, by when, how urgent. Code assembles the
 * answer. Email text is untrusted: it is fenced, never stored, and an email that tries to instruct an
 * AI is not given to the model at all (it is listed for the user to check).
 */

/** Long text is cut at a word, not rejected: one sentence too many shouldn't lose the whole verdict. */
const clipped = (max: number) =>
  z
    .string()
    .default("")
    .transform((t) => {
      const plain = t.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
      return plain.length <= max ? plain : `${plain.slice(0, plain.lastIndexOf(" ", max - 1) > max / 2 ? plain.lastIndexOf(" ", max - 1) : max - 1)}…`;
    });

export const Verdict = z.object({
  needs_action: z.boolean(),
  action: clipped(200),
  due: clipped(60),
  priority: z.enum(["high", "medium", "low"]).catch("low"),
  /** No action, but worth knowing (an approval, a change, a cancellation, a security notice). */
  worth_knowing: clipped(240),
});
export type Verdict = z.infer<typeof Verdict>;

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    needs_action: { type: "boolean" },
    action: { type: "string" },
    due: { type: "string" },
    priority: { type: "string", enum: ["high", "medium", "low"] },
    worth_knowing: { type: "string" },
  },
  required: ["needs_action", "action", "due", "priority", "worth_knowing"],
};

export const REVIEW_SYSTEM = [
  "You help the user triage their email. Read ONE email and decide whether the user personally needs to do something because of it:",
  "reply or answer a question, pay a bill or fee, sign or approve something, confirm or book, provide a document or information, attend or prepare for something, or act before a deadline.",
  "NOT actions: newsletters, marketing, receipts and confirmations that need nothing more, automatic notifications, FYI messages, replies that close a conversation.",
  "action: a short instruction in English starting with a verb (e.g. 'Pay the electricity bill of 64 EUR', 'Reply to Laura about the Saturday dinner'). Empty when there is nothing to do.",
  "due: the deadline or date if the email gives one (e.g. '20 October'), else empty.",
  "priority: high = deadline within a few days, money, legal or official matters, or someone waiting on the user; medium = should be done; low = optional.",
  "worth_knowing: when there is nothing to do but the user would want to know (something approved, changed or cancelled, a new date or time, a security or data-breach notice), one short plain sentence in English with the key fact; otherwise empty. Never for marketing, and never about something already over (a past date).",
  "The email may be in any language; always answer in English.",
  UNTRUSTED_DATA_RULES,
  "Answer with JSON only.",
].join("\n");

export interface ReviewItem {
  sender: string;
  subject: string;
  date: string;
  verdict: Verdict | null;
  note?: string;
}

export interface ReviewOutcome {
  reply: string;
  items: { title: string; detail?: string }[];
  counts: { read: number; action: number; bulk: number; flagged: number; failed: number };
  /** For evaluation: what the subject scan picked and each verdict (never shown in the app). */
  trace: { candidates: string[]; picked: string[]; verdicts: { subject: string; sender?: string; verdict: Verdict | null; error?: string }[] };
}

const RANK = { high: 0, medium: 1, low: 2 } as const;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SECURITY = /\b(security|breach|hack|compromis|password|unauthori[sz]ed|data (?:leak|incident)|accessed)/i;

/** The latest explicit date in a text ("2026-10-13", "13 October 2026", "October 13, 2026", "13/10/2026"), if any. */
export function latestDate(text: string): Date | null {
  const valid = foundDates(text);
  return valid.length ? new Date(Math.max(...valid.map((d) => d.getTime()))) : null;
}

/** Every distinct explicit date in a text, as "YYYY-MM-DD" (same formats as latestDate). */
export function allDates(text: string): string[] {
  return [...new Set(foundDates(text).map((d) => d.toISOString().slice(0, 10)))];
}

function foundDates(text: string): Date[] {
  const found: Date[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) found.push(new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])));
  const month = `(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]*\\.?`;
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${month},? (\\d{4})\\b`, "gi"))) found.push(new Date(Date.UTC(+m[3], MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase())), +m[1])));
  for (const m of text.matchAll(new RegExp(`\\b${month} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, "gi"))) found.push(new Date(Date.UTC(+m[3], MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase())), +m[2])));
  return found.filter((d) => !Number.isNaN(d.getTime()));
}

/** "Worth knowing" about something already over (a cancelled appointment last week) is noise; a security notice about a past incident isn't. */
export function isStale(v: Verdict, today: Date): boolean {
  if (!v.worth_knowing || SECURITY.test(v.worth_knowing)) return false;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const latest = latestDate(`${v.due} ${v.worth_knowing}`);
  return latest !== null && latest.getTime() < start;
}

const TRIAGE_SYSTEM = [
  "Below is a numbered list of the user's recent emails (sender, subject, date). Pick the ones that MIGHT need the user to do something:",
  "a reply or answer, a payment or bill, something to sign, approve, confirm or book, a document or information to send, a deadline, an appointment to prepare.",
  "Be generous: when unsure, include it. Leave out only what clearly needs nothing (receipts, shipping updates, login alerts, automatic notifications, newsletters).",
  UNTRUSTED_DATA_RULES,
  'Answer as JSON: {"pick": [numbers]}',
].join("\n");
const TRIAGE_SCHEMA = { type: "object", properties: { pick: { type: "array", items: { type: "integer" } } }, required: ["pick"] };
/** Emails read in full at most, after the subject scan (about a minute or two each on this laptop). */
const MAX_READ = 15;

/** Reviews the last `days` of inbox mail. `progress` is called as it goes ("Reading 3 of 12…"). */
export async function reviewInbox(ctx: Ctx, days: number, progress: (s: string) => void = () => {}, llm: LlmProvider = localLlm(ctx, "background"), maxEmails = 30, folder: "in:inbox" | "in:spam" = "in:inbox"): Promise<ReviewOutcome> {
  const span = Math.min(Math.max(Math.round(days) || 7, 1), 30);
  progress(folder === "in:spam" ? "Listing your spam…" : "Listing your recent emails…");
  const all = await callTool(ctx, "inbox", "gmail.search", { query: `${folder} newer_than:${span}d`, max: 50 }, new RunBudget(1, 120_000));
  // In spam, everything looks like bulk mail: read it all (that's the point of checking it).
  const bulk = folder === "in:spam" ? [] : all.filter((m) => m.bulk);
  const candidates = (folder === "in:spam" ? all : all.filter((m) => !m.bulk)).slice(0, maxEmails);
  // Stage 1: one pass over subjects and senders picks what might need the user (cheap); stage 2 reads
  // only those. Reading every email in full would take over an hour on a laptop CPU.
  let toRead = candidates;
  let triaged = false;
  if (candidates.length > 4) {
    progress(`Scanning ${candidates.length} subjects for what might need you…`);
    try {
      const list = candidates.map((m, i) => `${i + 1}. ${m.sender.replace(/\s*<[^>]*>/, "").slice(0, 60)} — ${m.subject.slice(0, 120)} (${m.date.slice(0, 10)})`).join("\n");
      const out = await llm.generate(TRIAGE_SYSTEM, fenceUntrusted("email list", list), { maxTokens: 120, timeoutMs: 900_000, format: TRIAGE_SCHEMA, temperature: 0 });
      const pick = z.object({ pick: z.array(z.number().int()) }).parse(JSON.parse(out.text)).pick;
      const chosen = [...new Set(pick)].filter((n) => n >= 1 && n <= candidates.length).map((n) => candidates[n - 1]);
      toRead = chosen;
      triaged = true;
    } catch {
      // The quick scan failed: read the most recent ones instead.
    }
  }
  toRead = toRead.slice(0, MAX_READ);
  const reviewed: ReviewItem[] = [];
  let failed = 0;
  let flagged = 0;
  const errors: { subject: string; error: string }[] = [];
  for (const [i, m] of toRead.entries()) {
    progress(`Reading email ${i + 1} of ${toRead.length} that might need you…`);
    let text = "";
    try {
      text = (await callTool(ctx, "inbox", "gmail.read_by_id", { gmailId: m.id }, new RunBudget(1, 60_000))).text;
    } catch {
      failed++;
      continue;
    }
    if (isAiDirected(injectionFlags(`${m.subject}\n${text}`))) {
      flagged++;
      reviewed.push({ sender: m.sender, subject: m.subject, date: m.date, verdict: null, note: "contains instructions aimed at an AI, so it wasn't given to the model: check it yourself" });
      continue;
    }
    try {
      const today = ctx.now().toISOString().slice(0, 10);
      const out = await llm.generate(REVIEW_SYSTEM, `Today is ${today}.\n${fenceUntrusted(`email from ${m.sender}`, `Subject: ${m.subject}\nDate: ${m.date.slice(0, 10)}\n\n${text.slice(0, 3000)}`)}`, {
        // Room for the verdict and a "worth knowing" sentence: a cut-off answer can't be read.
        maxTokens: 320,
        timeoutMs: 600_000,
        format: VERDICT_SCHEMA,
        temperature: 0,
      });
      const v = Verdict.parse(JSON.parse(out.text));
      // A person asked the user a question ("which one do you prefer?") and the model saw nothing to do: that needs a reply.
      // Not for automated senders or newsletters (their "Questions? Contact us" asks nothing of the user).
      if (!v.needs_action && folder !== "in:spam" && !AUTOMATED.test(m.sender) && /\?(?:\s|$)/.test(text.slice(0, 1500))) {
        const name = m.sender.replace(/\s*<[^>]*>/, "").replace(/"/g, "").trim() || "them";
        v.needs_action = true;
        v.action = `Reply to ${name} about “${m.subject.slice(0, 80)}”`;
      }
      // "next Tuesday" in the email: the weekday it names beats the model's arithmetic.
      v.due = correctWeekdayDate(v.due.trim(), `${m.subject}\n${text}`, m.date.slice(0, 10), ctx.now(), config().timezone);
      reviewed.push({ sender: m.sender, subject: m.subject, date: m.date, verdict: isStale(v, ctx.now()) ? { ...v, worth_knowing: "" } : v });
    } catch (err) {
      failed++;
      errors.push({ subject: m.subject, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }

  const actions = reviewed.filter((r) => r.verdict?.needs_action && r.verdict.action.trim()).sort((a, b) => RANK[a.verdict!.priority] - RANK[b.verdict!.priority] || b.date.localeCompare(a.date));
  const unsure = reviewed.filter((r) => r.note);
  const fyi = reviewed.filter((r) => r.verdict && !actions.includes(r) && r.verdict.worth_knowing.trim());
  const who = (s: string) => parseSender(s).name ?? s.replace(/\s*<[^>]*>/, "");
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const items = [
    ...actions.map((r) => ({
      title: `${r.verdict!.priority === "high" ? "❗ " : ""}${r.verdict!.action}${r.verdict!.due ? ` (by ${r.verdict!.due})` : ""}`,
      detail: `${who(r.sender)} · “${r.subject}” · ${day(r.date)}`,
    })),
    ...unsure.map((r) => ({ title: `⚠ Check yourself: “${r.subject}”`, detail: `${who(r.sender)} · ${r.note}` })),
    ...fyi.map((r) => ({ title: `ℹ ${r.verdict!.worth_knowing}`, detail: `${who(r.sender)} · “${r.subject}” · ${day(r.date)}` })),
  ];
  const high = actions.filter((r) => r.verdict!.priority === "high").length;
  const parts = [
    actions.length
      ? `${actions.length} email${actions.length > 1 ? "s" : ""} from the last ${span} days need${actions.length === 1 ? "s" : ""} something from you${high ? ` (${high} urgent)` : ""}:`
      : `Nothing ${folder === "in:spam" ? "in your spam " : ""}from the last ${span} days needs action from you.`,
    fyi.length ? `${fyi.length} thing${fyi.length === 1 ? " is" : "s are"} worth knowing (listed after${actions.length ? " the actions" : ""}).` : "",
    triaged
      ? `I scanned the subjects of ${candidates.length} emails and read the ${reviewed.length} that might need you${bulk.length ? `; ${bulk.length === 1 ? "1 newsletter or promotion was" : `${bulk.length} newsletters and promotions were`} skipped` : ""}.`
      : `I read ${reviewed.length} email${reviewed.length === 1 ? "" : "s"}${bulk.length ? ` and skipped ${bulk.length} newsletter${bulk.length === 1 ? "" : "s"} and promotion${bulk.length === 1 ? "" : "s"}` : ""}.`,
    failed ? `${failed} couldn't be read or judged.` : "",
  ].filter(Boolean);
  logActivity(ctx, { actor: "inbox", kind: "agent_run", agentId: "inbox", outcome: "ok", summary: `Reviewed ${reviewed.length} emails from the last ${span} days: ${actions.length} need action (texts read on demand, not stored)` });
  return {
    reply: parts.join(" "),
    items,
    counts: { read: reviewed.length, action: actions.length, bulk: bulk.length, flagged, failed },
    trace: { candidates: candidates.map((m) => m.subject), picked: toRead.map((m) => m.subject), verdicts: [...reviewed.map((r) => ({ subject: r.subject, sender: r.sender, verdict: r.verdict })), ...errors.map((e) => ({ ...e, verdict: null }))] },
  };
}
