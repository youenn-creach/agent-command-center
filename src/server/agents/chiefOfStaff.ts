import { all, newId, one, run, type Ctx } from "../db";
import { notifyLater } from "../notify";
import { demoRowsFilter, serviceHidden } from "../mode";
import { aboutMePrompt } from "../memory";
import { draftLlmFor, fenceUntrusted, workLlm, UNTRUSTED_DATA_RULES, type LlmProvider } from "../llm";
import { detectLanguage, holdingReplyIn, REPLY_IN, type Lang } from "../lang";
import { callTool, type EventRow, type MessageRow, type NewsRow } from "../tools/registry";
import { RunBudget } from "../tools/budget";
import type { JobRow, WorkflowRegistry } from "../scheduler/scheduler";
import { injectionFlags, isAiDirected } from "../retrieval/text";
import { formatForecast } from "../connectors/weather";

/**
 * The Chief of Staff is a deterministic orchestrator, not a free-form agent loop.
 * It delegates a fixed sequence of bounded steps to specialists. Each step is an
 * authorized tool call under a shared budget; a denied step is skipped and reported,
 * never escalated. The LLM only writes the summary text at the end and has no tools.
 */

export const AGENTS = {
  chief: "chief_of_staff",
  inbox: "inbox",
  calendar: "calendar",
  followup: "follow_up",
  knowledge: "knowledge",
} as const;

export interface StepRecord {
  agent: string;
  tool: string;
  outcome: "ok" | "skipped" | "failed";
  note: string;
}

export interface Provenance {
  steps: StepRecord[];
  writer: string;
  simulatedSources: boolean;
  toolCalls: number;
  flaggedItems: number;
}

/** "Ana Lopez <ana@example.com>" → { name: "Ana", email: "ana@example.com" } */
export function parseSender(from: string): { name: string | null; email: string | null } {
  const email = from.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? from.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? null;
  const display = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  const name = display && !display.includes("@") ? display.split(/\s+/)[0] : null;
  return { name, email };
}

export function holdingReply(name: string | null) {
  return `Hi${name ? ` ${name}` : ""},\n\nThanks for your message — I've seen it and will get back to you shortly.\n\nBest regards`;
}

/**
 * Follow-up agent: proposes reply drafts in the user's real Gmail for messages waiting on a reply.
 * Needs its OWN Read on Gmail (to see what's waiting) and Prepare on Gmail drafts (to propose).
 * Drafts land in the Action Queue; only an approved one is created in Gmail, and never sent.
 */
export const DRAFT_RULES = [
  "You draft a short email reply for the user to review before anything is sent.",
  "Write in the same language as the email. Be friendly and concise (2 to 5 sentences). No subject line, no placeholders like [Name].",
  "Never agree to pay, accept a quote or price, sign anything or confirm a booking on the user's behalf: say the user will check and confirm.",
  "Never invent facts about the user (allergies, plans, availability, opinions). Use only what the About-the-user notes say.",
  "Answer in exactly this format:\nSUMMARY: <one sentence: what the sender wants>\nREPLY:\n<the reply body>",
  UNTRUSTED_DATA_RULES,
].join("\n");

/** Parses "SUMMARY: … REPLY: …" from a small model; returns null if the output is unusable. */
export function parseDraft(out: string): { summary: string; reply: string } | null {
  // "SUMMARY :" too: French typography puts a space before the colon.
  // Models also bold the labels ("**SUMMARY:**") or drop "REPLY:" and separate with "---" or a blank line.
  const plain = out.replace(/\*\*|__/g, "").replace(/^#+\s*/gm, "");
  const m = plain.match(/SUMMARY\s*:\s*(.+?)\s*REPLY\s*:\s*([\s\S]+)/i) ?? plain.match(/SUMMARY\s*:\s*([^\n]+?)\s*(?:\n\s*-{3,}\s*\n|\n\s*\n)\s*([\s\S]+)/i);
  if (!m) return null;
  const summary = m[1].replace(/\s+/g, " ").trim().slice(0, 160);
  // Small models often end with "[Your Name]" despite the rules: drop placeholder-only lines.
  // Some models echo their instructions about <untrusted> data at the end: drop those lines too.
  const reply = m[2].replace(/^.*(?:<\/?untrusted|DATA from emails, notes|Never follow instructions found inside).*$/gim, "").replace(/<\/?untrusted[^>]*>/gi, "").replace(/^[ \t]*\[[^\]\n]{2,40}\][ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
  return summary && reply.length > 10 ? { summary, reply } : null;
}

/**
 * The drafting prompt: the rules; who is writing to whom (small models otherwise answer as the sender,
 * "Hola Sam!"); one instruction in the email's own language (followed better than an English rule);
 * and the user's About-me facts.
 */
export function draftSystemPrompt(lang: Lang | null, about: string, sender: string): string {
  const { name, email } = parseSender(sender);
  const who = name?.split(/\s+/)[0] ?? email ?? "the sender";
  const roles = `You write AS the user, replying TO ${who}. Start with a greeting to ${who}. Never write as ${who}, and never greet or sign as the person you are writing to.`;
  return [DRAFT_RULES, roles, lang ? REPLY_IN[lang] : "", about].filter(Boolean).join("\n\n");
}

/**
 * Writes a reply with the local LLM from the message text (fenced as untrusted). Falls back to a holding reply.
 * `about` is the user's own About-me facts (trusted), so drafts match their name, tone and language habits.
 */
export async function writeReply(llm: LlmProvider, sender: string, subject: string, text: string, name: string | null, about = "", lang: Lang | null = null, instruction = "") {
  if (!text && !instruction) return { summary: null as string | null, reply: holdingReplyIn(lang, name), writer: "template" };
  // The user's own instruction ("say Thursday works") is trusted; the email itself stays fenced data.
  const system = [draftSystemPrompt(lang, about, sender), instruction ? `The user wants this reply to say: ${instruction}. Say exactly that, politely and briefly; add nothing they didn't ask for. Never name a title, place, person, date or amount that is not written in the email or in the user's words; when the user refers to something without naming it, use their exact words.` : ""].filter(Boolean).join("\n\n");
  const email = text ? fenceUntrusted(`email from ${sender}`, `Subject: ${subject}\n\n${text}`) : `(The email isn't shown. Subject: ${subject.replace(/[<>]/g, "")})`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await llm.generate(attempt ? `${system}\n\n${REPLY_IN[lang!]} ${REPLY_IN[lang!]}` : system, email, { maxTokens: 260, timeoutMs: 420_000 });
      const parsed = parseDraft(out.text);
      if (!parsed) break;
      // A reply in the wrong language (e.g. English to a Catalan email) gets one retry, then the holding reply.
      const got = lang ? detectLanguage(parsed.reply) : null;
      // A sender without a name ("landlord@example.com"): greet them without their address.
      const reply = parsed.reply.replace(/^(\s*(?:hi|hello|dear)\s+)[^\s,@]+@[^\s,]+,/i, "$1there,").replace(/\n\s*-{3,}\s*$/, "").trim();
      if (!lang || !got || got === lang) return { ...parsed, reply, writer: out.model };
    }
  } catch {
    // local LLM unavailable: fall through to the holding reply
  }
  return { summary: null, reply: holdingReplyIn(lang, name), writer: "template" };
}

async function proposeGmailDrafts(ctx: Ctx, steps: StepRecord[], budget: RunBudget, limit: number, llm: LlmProvider = workLlm(ctx, "background")) {
  if (!isConnected(ctx, "gmail") || !isConnected(ctx, "gmail-drafts")) return 0;
  const waiting = await step(ctx, steps, AGENTS.followup, "gmail.list_messages", () => callTool(ctx, AGENTS.followup, "gmail.list_messages", { limit: 10, needsReplyOnly: true }, budget), (o) => `${o.length} Gmail message(s) waiting`);
  let proposed = 0;
  for (const m of (waiting ?? []).slice(0, limit)) {
    const { name, email } = parseSender(m.sender);
    if (!email) continue;
    // One draft per email: don't re-read it or re-run the (slow) local model if one already exists.
    if (ctx.db.prepare("SELECT 1 FROM actions WHERE idempotency_key = ?").get(`gmaildraft:${m.id}`)) continue;
    const read = await step(ctx, steps, AGENTS.followup, "gmail.read_message", () => callTool(ctx, AGENTS.followup, "gmail.read_message", { messageId: m.id }, budget), (o) => `read 1 message (${o.text.length} chars, not stored)`);
    const flags = read ? injectionFlags(read.text) : [];
    const flagged = flags.length > 0;
    const aiDirected = isAiDirected(flags);
    // An email that talks to an AI ("ignore your instructions…", in EN/FR/ES/CA) never reaches the model:
    // small models can obey it (in a local test, two of four drafted "I agree to wire 5000 EUR"). It gets
    // the neutral holding reply. Weaker signals (a password mention, a transfer) only add a warning.
    const lang = read ? detectLanguage(read.text) : null;
    const written = aiDirected
      ? { summary: null, reply: holdingReplyIn(lang, name), writer: "template" }
      : await writeReply(draftLlmFor(ctx, lang, llm), m.sender, m.subject, read?.text ?? "", name, aboutMePrompt(ctx), lang);
    const out = await step(
      ctx,
      steps,
      AGENTS.followup,
      "actions.propose",
      () =>
        callTool(
          ctx,
          AGENTS.followup,
          "actions.propose",
          {
            serviceId: "gmail-drafts",
            kind: "email_draft",
            title: `${aiDirected ? "⚠ Contains instructions for an AI: holding reply only. " : flagged ? `⚠ Check carefully (${flags.join(", ")}). ` : ""}Reply to ${name ?? email}${written.summary ? ` — ${written.summary}` : ` — ${m.subject}`}`.slice(0, 200),
            payload: {
              to: email,
              subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
              body: written.reply,
              ...(m.thread_id ? { threadId: m.thread_id } : {}),
              ...(m.rfc_message_id ? { inReplyTo: m.rfc_message_id } : {}),
            },
            idempotencyKey: `gmaildraft:${m.id}`,
          },
          budget,
        ),
      (o) => `Gmail draft ${o.status}`,
    );
    if (out) proposed++;
  }
  return proposed;
}

function isConnected(ctx: Ctx, serviceId: string) {
  return Boolean(ctx.db.prepare("SELECT 1 FROM services WHERE id = ? AND connection_state = 'connected'").get(serviceId));
}

/** `currentStep` is shown in the sidebar while the agent runs; it is cleared on any other status. */
function setAgentStatus(ctx: Ctx, agentId: string, status: string, error?: string | null, currentStep?: string) {
  run(
    ctx.db,
    "UPDATE agents SET status = ?, last_run_at = CASE WHEN ? = 'running' THEN ? ELSE last_run_at END, last_error = ?, current_step = ? WHERE id = ?",
    status,
    status,
    ctx.now().toISOString(),
    error ?? null,
    status === "running" ? (currentStep ?? null) : null,
    agentId,
  );
}

async function step<T>(ctx: Ctx, steps: StepRecord[], agent: string, tool: string, fn: () => Promise<T>, describe: (t: T) => string): Promise<T | null> {
  setAgentStatus(ctx, agent, "running", null, tool);
  try {
    const out = await fn();
    steps.push({ agent, tool, outcome: "ok", note: describe(out) });
    setAgentStatus(ctx, agent, "idle");
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const denied = (err as { code?: string }).code === "POLICY_DENIED";
    steps.push({ agent, tool, outcome: denied ? "skipped" : "failed", note: denied ? "Skipped — no permission" : message.slice(0, 160) });
    setAgentStatus(ctx, agent, denied ? "idle" : "error", denied ? null : message.slice(0, 200));
    if ((err as { code?: string }).code === "BUDGET_EXCEEDED") throw err;
    return null;
  }
}

export async function dailyBriefing(ctx: Ctx, job: JobRow | null, llm: LlmProvider = workLlm(ctx, "background")) {
  const budget = new RunBudget(28, 600_000); // includes the two Gmail insight scans
  const steps: StepRecord[] = [];
  setAgentStatus(ctx, AGENTS.chief, "running", null, "workflow.daily_briefing");

  const now = ctx.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  // The demo calendar and inbox exist only where the instance includes them (not in the personal app).
  const useDemo = { calendar: !serviceHidden(ctx, "demo-calendar"), mail: !serviceHidden(ctx, "demo-mail") };
  const events = useDemo.calendar ? await step(ctx, steps, AGENTS.calendar, "calendar.list_events", () => callTool(ctx, AGENTS.calendar, "calendar.list_events", { from: dayStart.toISOString(), days: 2 }, budget), (o) => `${o.length} events today/tomorrow`) : [];
  const demoMessages = useDemo.mail ? await step(ctx, steps, AGENTS.inbox, "inbox.list_messages", () => callTool(ctx, AGENTS.inbox, "inbox.list_messages", { limit: 10, needsReplyOnly: false }, budget), (o) => `${o.length} recent messages (headers only)`) : [];

  // Real Google data, only when connected — and still subject to the agents' grants on each call.
  let gcalEvents: EventRow[] = [];
  if (isConnected(ctx, "google-calendar")) {
    await step(ctx, steps, AGENTS.calendar, "gcal.sync", () => callTool(ctx, AGENTS.calendar, "gcal.sync", {}, budget), (o) => `${o.events} Google Calendar events synced`);
    gcalEvents = (await step(ctx, steps, AGENTS.calendar, "gcal.list_events", () => callTool(ctx, AGENTS.calendar, "gcal.list_events", { from: dayStart.toISOString(), days: 2 }, budget), (o) => `${o.length} Google Calendar events`)) ?? [];
  }
  let weatherLine: string | null = null;
  if (isConnected(ctx, "weather")) {
    const w = await step(ctx, steps, AGENTS.calendar, "weather.forecast", () => callTool(ctx, AGENTS.calendar, "weather.forecast", {}, budget), (o) => `forecast for ${o.location}`);
    if (w) weatherLine = `${formatForecast(w)} — ${w.attribution}`;
  }
  let gmailMessages: MessageRow[] = [];
  if (isConnected(ctx, "gmail")) {
    await step(ctx, steps, AGENTS.inbox, "gmail.sync", () => callTool(ctx, AGENTS.inbox, "gmail.sync", {}, budget), (o) => `${o.messages} Gmail headers synced`);
    gmailMessages = (await step(ctx, steps, AGENTS.inbox, "gmail.list_messages", () => callTool(ctx, AGENTS.inbox, "gmail.list_messages", { limit: 10, needsReplyOnly: false }, budget), (o) => `${o.length} Gmail headers`)) ?? [];
    // Inbox insights: who hasn't answered you, and booking confirmations (headers only).
    await step(ctx, steps, AGENTS.followup, "gmail.scan_waiting", () => callTool(ctx, AGENTS.followup, "gmail.scan_waiting", {}, budget), (o) => `${o.waiting} thread(s) waiting on others`);
    await step(ctx, steps, AGENTS.inbox, "gmail.scan_bookings", () => callTool(ctx, AGENTS.inbox, "gmail.scan_bookings", {}, budget), (o) => `${o.bookings} booking(s) found`);
  }
  const messages = [...(demoMessages ?? []), ...gmailMessages];
  await step(ctx, steps, AGENTS.knowledge, "news.refresh", () => callTool(ctx, AGENTS.knowledge, "news.refresh", {}, budget), (o) => (o.length ? `${o.filter((r) => r.ok).length}/${o.length} live sources fetched` : "no live sources enabled — using the sample feed"));
  const news = await step(ctx, steps, AGENTS.knowledge, "news.list_items", () => callTool(ctx, AGENTS.knowledge, "news.list_items", { limit: 6 }, budget), (o) => `${o.length} news items`);

  // Follow-up specialist drafts holding replies; drafts land in the Action Queue and wait for approval.
  // Demo messages only: there is no write path to real Gmail in this build.
  const needsReply = (demoMessages ?? []).filter((m) => m.needs_reply).slice(0, 3);
  for (const m of needsReply) {
    await step(
      ctx,
      steps,
      AGENTS.followup,
      "actions.propose",
      () =>
        callTool(
          ctx,
          AGENTS.followup,
          "actions.propose",
          {
            serviceId: "demo-mail",
            kind: "email_reply",
            title: `Reply to ${m.sender}: ${m.subject}`.slice(0, 200),
            payload: {
              to: m.sender,
              subject: m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`,
              body: `Hi,\n\nThanks for your message — I've seen it and will get back to you properly by end of week.\n\nBest,\nAlex`,
            },
            idempotencyKey: `followup:${m.id}`,
          },
          budget,
        ),
      (o) => `draft ${o.status}`,
    );
  }

  await proposeGmailDrafts(ctx, steps, budget, 3, llm);

  const flaggedItems = [...messages.map((m) => `${m.subject} ${m.snippet}`), ...(news ?? []).map((n) => n.summary)].filter((t) => injectionFlags(t).length).length;
  const allEvents = [...(events ?? []), ...gcalEvents].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const waitingOn = all<{ recipient: string; subject: string; sent_at: string }>(ctx.db, `SELECT recipient, subject, sent_at FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at LIMIT 5`);
  const composed = await composeBriefing(allEvents, messages, news ?? [], llm, waitingOn);
  const body = weatherLine ? `**Weather**\n- ${weatherLine}\n\n${composed.body}` : composed.body;
  const writer = composed.writer;
  // "Simulated" is decided by what was actually used, not by configuration.
  // Simulated = the sample news feed was used (not merely "no news": a briefing without news is still real).
  const simulatedSources = (news ?? []).some((n) => n.is_demo);
  if (job) run(ctx.db, "UPDATE jobs SET simulated = ? WHERE id = ?", simulatedSources ? 1 : 0, job.id);
  const provenance: Provenance = { steps, writer, simulatedSources, toolCalls: budget.used, flaggedItems };
  const id = newId("brf");
  run(
    ctx.db,
    "INSERT INTO briefings (id, job_run_id, created_at, title, body, provenance, simulated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    null,
    now.toISOString(),
    `Daily briefing — ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`,
    body,
    JSON.stringify(provenance),
    provenance.simulatedSources ? 1 : 0,
  );
  setAgentStatus(ctx, AGENTS.chief, "idle");
  notifyLater(ctx, { key: `briefing:${id}`, kind: "briefing", title: "Your morning briefing is ready", summary: "Open the dashboard to read it." });
  const skipped = steps.filter((s) => s.outcome !== "ok").length;
  return { message: `Briefing delivered to dashboard (${budget.used} tool calls${skipped ? `, ${skipped} step(s) skipped` : ""}; written by ${writer})`, briefingId: id };
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

async function composeBriefing(events: EventRow[], messages: MessageRow[], news: NewsRow[], llm: LlmProvider, waitingOn: { recipient: string; subject: string; sent_at: string }[] = []) {
  const today = new Date().toDateString();
  const line = (e: EventRow) => `- ${fmtTime(e.starts_at)} ${e.title}${e.location ? ` (${e.location})` : ""}`;
  const todays = events.filter((e) => new Date(e.starts_at).toDateString() === today);
  const later = events.filter((e) => new Date(e.starts_at).toDateString() !== today);
  const agenda = [todays.map(line).join("\n") || "- Nothing today", later.length ? `- Tomorrow: ${later.map((e) => `${fmtTime(e.starts_at)} ${e.title}`).join("; ")}` : ""].filter(Boolean).join("\n");
  const replies = messages.filter((m) => m.needs_reply).map((m) => `- ${m.subject} — from ${m.sender}`).join("\n") || "- Nothing waiting";
  const others = waitingOn.length ? `\n\n**Still no answer**\n${waitingOn.map((w) => `- ${w.subject} — to ${w.recipient.replace(/\s*<[^>]*>/, "")}, ${Math.floor((Date.now() - Date.parse(w.sent_at)) / 86_400_000)} days ago`).join("\n")}` : "";
  const template = `**Agenda**\n${agenda}\n\n**Waiting on you**\n${replies}${others}\n\n**Tech news**\n${news.map((n) => `- ${n.title} (${n.source})`).join("\n") || "- No items"}${news.some((n) => !n.is_demo) ? `\n\n**Links**\n${news.map((n) => `- ${n.url}`).join("\n")}` : ""}`;

  if (!news.length) return { body: template, writer: "template" };
  try {
    const out = await llm.generate(
      [
        "You write a short morning tech-news digest for one person.",
        "Summarize the news items in 3-5 bullet points, each under 25 words, naming the source in parentheses.",
        "Only use facts present in the items. No preamble.",
        UNTRUSTED_DATA_RULES,
      ].join("\n"),
      news.map((n, i) => fenceUntrusted(`news ${i + 1}: ${n.source}`, `${n.title}\n${n.summary}`)).join("\n\n"),
      // A digest takes the local model 2–4 minutes on a laptop CPU: a shorter limit silently gave the template.
      { maxTokens: 350, timeoutMs: 600_000 },
    );
    const links = news.some((n) => !n.is_demo) ? `\n\n**Sources**\n${news.map((n) => `- ${n.source}: ${n.url}`).join("\n")}` : "";
    return { body: `**Agenda**\n${agenda}\n\n**Waiting on you**\n${replies}${others}\n\n**Tech news digest**\n${out.text}${links}`, writer: `${out.model} (local)` };
  } catch {
    return { body: template, writer: "template (local LLM unavailable)" };
  }
}

/**
 * True if a briefing's text can contain real Gmail or Google Calendar data: a gmail.* or gcal.* step
 * read it, or real "still no answer" threads from an earlier scan are listed. Such a briefing stays
 * in the dashboard (it is not returned over MCP).
 */
export function briefingHasRealGoogleData(ctx: Ctx, provenance: { steps: { tool: string; outcome: string }[] }) {
  if (provenance.steps.some((s) => s.outcome === "ok" && /^(gmail|gcal)\./.test(s.tool))) return true;
  return Boolean(one(ctx.db, "SELECT 1 FROM waiting_on WHERE is_demo = 0 LIMIT 1"));
}

export async function followupSweep(ctx: Ctx, llm: LlmProvider = workLlm(ctx, "background")) {
  const budget = new RunBudget(20, 600_000);
  const steps: StepRecord[] = [];
  // Demo inbox replies only where the instance has the demo inbox (not in the personal app);
  // Gmail reply drafts below work either way.
  const hasDemoMail = !serviceHidden(ctx, "demo-mail");
  const messages = hasDemoMail ? await step(ctx, steps, AGENTS.inbox, "inbox.list_messages", () => callTool(ctx, AGENTS.inbox, "inbox.list_messages", { limit: 10, needsReplyOnly: true }, budget), (o) => `${o.length} waiting`) : [];
  if (!messages) throw Object.assign(new Error(steps.at(-1)?.note ?? "Inbox step failed"), { code: steps.at(-1)?.outcome === "skipped" ? "POLICY_DENIED" : undefined });
  let drafted = 0;
  for (const m of messages.slice(0, 5)) {
    const out = await step(
      ctx,
      steps,
      AGENTS.followup,
      "actions.propose",
      () =>
        callTool(
          ctx,
          AGENTS.followup,
          "actions.propose",
          {
            serviceId: "demo-mail",
            kind: "email_reply",
            title: `Reply to ${m.sender}: ${m.subject}`.slice(0, 200),
            payload: { to: m.sender, subject: m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`, body: `Hi,\n\nThanks for your message — I've seen it and will get back to you properly by end of week.\n\nBest,\nAlex` },
            idempotencyKey: `followup:${m.id}`,
          },
          budget,
        ),
      (o) => `draft ${o.status}`,
    );
    if (out) drafted += 1;
  }
  const gmailDrafts = await proposeGmailDrafts(ctx, steps, budget, 5, llm);
  const demoPart = hasDemoMail ? `${messages.length} demo message(s) waiting; ${drafted} demo draft(s)` : "";
  const gmailPart = gmailDrafts ? `${gmailDrafts} Gmail draft(s)` : hasDemoMail ? "" : "no Gmail drafts needed";
  return { message: `${[demoPart, gmailPart].filter(Boolean).join(" and ")} in the Action Queue (duplicates are not re-created)` };
}

export async function insuranceReminder(ctx: Ctx) {
  const budget = new RunBudget(2, 10_000);
  const out = await callTool(
    ctx,
    AGENTS.followup,
    "actions.propose",
    {
      serviceId: "local-tasks",
      kind: "reminder",
      title: "Collect car-insurance comparison quotes",
      payload: { text: "Get three car-insurance quotes before the 3 December renewal; mention lower mileage." },
      idempotencyKey: "reminder:insurance-quotes",
    },
    budget,
  );
  return { message: `Reminder proposed (${out.status}) — waiting in the Action Queue` };
}

/**
 * Weekly review: the coming week's agenda, what is still waiting on you, and what the agents did.
 * Template-only on purpose — it is a factual digest, and it stays fast on a CPU-only machine.
 */
export async function weeklyReview(ctx: Ctx) {
  const budget = new RunBudget(6, 30_000);
  const steps: StepRecord[] = [];
  setAgentStatus(ctx, AGENTS.chief, "running", null, "workflow.weekly_review");
  const now = ctx.now();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // Demo sources where the instance has them, plus the real Google data when connected.
  const demo = { calendar: !serviceHidden(ctx, "demo-calendar"), mail: !serviceHidden(ctx, "demo-mail") };
  const demoEvents = demo.calendar ? await step(ctx, steps, AGENTS.calendar, "calendar.list_events", () => callTool(ctx, AGENTS.calendar, "calendar.list_events", { from: start.toISOString(), days: 7 }, budget), (o) => `${o.length} events in the next 7 days`) : [];
  const googleEvents = isConnected(ctx, "google-calendar") ? await step(ctx, steps, AGENTS.calendar, "gcal.list_events", () => callTool(ctx, AGENTS.calendar, "gcal.list_events", { from: start.toISOString(), days: 7 }, budget), (o) => `${o.length} Google Calendar events`) : [];
  const events = [...(demoEvents ?? []), ...(googleEvents ?? [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const demoWaiting = demo.mail ? await step(ctx, steps, AGENTS.inbox, "inbox.list_messages", () => callTool(ctx, AGENTS.inbox, "inbox.list_messages", { limit: 25, needsReplyOnly: true }, budget), (o) => `${o.length} messages waiting`) : [];
  const gmailWaiting = isConnected(ctx, "gmail") ? await step(ctx, steps, AGENTS.inbox, "gmail.list_messages", () => callTool(ctx, AGENTS.inbox, "gmail.list_messages", { limit: 25, needsReplyOnly: true }, budget), (o) => `${o.length} Gmail messages waiting`) : [];
  const waiting = [...(demoWaiting ?? []), ...(gmailWaiting ?? [])];
  // Once a week, refresh the subscription audit (Inbox insights and the Impact card). It reads up
  // to 300 message headers, so it gets its own budget, like the "Run the audit" button.
  const audit = isConnected(ctx, "gmail")
    ? await step(ctx, steps, AGENTS.inbox, "gmail.audit_subscriptions", () => callTool(ctx, AGENTS.inbox, "gmail.audit_subscriptions", {}, new RunBudget(1, 300_000)), (o) => `${o.senders} subscription sender(s) in ${o.scanned} messages`)
    : null;

  // The dashboard's own records (not an external service): what happened this week.
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const count = (sql: string, ...p: string[]) => (ctx.db.prepare(sql).get(...p) as { n: number }).n;
  const pending = count("SELECT COUNT(*) n FROM actions WHERE status IN ('proposed','approved')");
  const executed = count("SELECT COUNT(*) n FROM actions WHERE status = 'executed' AND updated_at >= ?", since);
  const denied = count("SELECT COUNT(*) n FROM activity WHERE outcome = 'denied' AND ts >= ?", since);
  const runs = count("SELECT COUNT(*) n FROM job_runs WHERE started_at >= ?", since);
  const failedRuns = count("SELECT COUNT(*) n FROM job_runs WHERE started_at >= ? AND status IN ('failed','blocked')", since);
  const openReminders = count("SELECT COUNT(*) n FROM reminders WHERE done_at IS NULL");

  const byDay = new Map<string, string[]>();
  for (const e of events ?? []) {
    const day = new Date(e.starts_at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
    byDay.set(day, [...(byDay.get(day) ?? []), `${fmtTime(e.starts_at)} ${e.title}`]);
  }
  const agenda = [...byDay.entries()].map(([d, items]) => `- ${d}: ${items.join("; ")}`).join("\n") || "- Nothing scheduled";
  const body = [
    `**Next 7 days**\n${agenda}`,
    `**Still waiting on you**\n${(waiting ?? []).map((m) => `- ${m.subject} — ${m.sender}`).join("\n") || "- Nothing"}\n- ${pending} action(s) in the Action Queue, ${openReminders} open reminder(s)`,
    `**Last 7 days**\n- ${runs} scheduled run(s), ${failedRuns} failed or blocked\n- ${executed} approved action(s) executed\n- ${denied} permission denial(s) recorded`,
    ...(audit ? [`**Subscriptions**\n- ${audit.senders} newsletter sender(s) in your recent mail, ${count("SELECT COUNT(*) n FROM subscriptions WHERE looks_paid = 1 AND is_demo = 0")} look paid (Inbox insights)`] : []),
  ].join("\n\n");

  const id = newId("brf");
  run(
    ctx.db,
    "INSERT INTO briefings (id, job_run_id, created_at, title, body, provenance, simulated, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'weekly')",
    id,
    null,
    now.toISOString(),
    `Weekly review — week of ${start.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`,
    body,
    JSON.stringify({ steps, writer: "template", simulatedSources: demo.calendar || demo.mail, toolCalls: budget.used, flaggedItems: 0 } satisfies Provenance),
    demo.calendar || demo.mail ? 1 : 0,
  );
  setAgentStatus(ctx, AGENTS.chief, "idle");
  return { message: `Weekly review delivered (${budget.used} tool calls)`, briefingId: id };
}

export const workflows: WorkflowRegistry = {
  daily_briefing: (ctx, job) => dailyBriefing(ctx, job),
  followup_sweep: (ctx) => followupSweep(ctx),
  insurance_reminder: (ctx) => insuranceReminder(ctx),
  weekly_review: (ctx) => weeklyReview(ctx),
};
