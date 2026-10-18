import { z } from "zod";
import { auditSubscriptions, scanBookings, scanWaitingOn } from "../connectors/gmailInsights";
import { appMode } from "../mode";
import { all, type Ctx } from "../db";
import { authorize } from "../policy/engine";
import { logActivity } from "../activity";
import type { AccessLevel } from "../policy/levels";
import { ActionKindSchema, proposeAction } from "../approvals";
import { retrieve } from "../retrieval/knowledge";
import { RunBudget } from "./budget";
import { refreshFeeds } from "../news/feeds";
import { fetchCalendarRange, readMessageText, readGmailById, searchGmail, syncCalendar, syncGmail } from "../connectors/google";
import { forecast, forecastFor } from "../connectors/weather";
import { readPage, searchWeb } from "../connectors/websearch";

/**
 * The complete set of things an agent can do. Each tool declares the service it touches and the
 * minimum access level, has a typed input schema, and is authorized server-side on every call.
 * There is intentionally no tool for executing external writes, changing permissions,
 * fetching arbitrary URLs, touching the filesystem, or running shell commands.
 */

interface ToolDef<I extends z.ZodType, O> {
  name: string;
  description: string;
  serviceId: string | ((input: z.infer<I>) => string);
  required: AccessLevel;
  input: I;
  run(ctx: Ctx, input: z.infer<I>, agentId: string): Promise<O> | O;
  summarize(output: O): string;
}

function tool<I extends z.ZodType, O>(def: ToolDef<I, O>) {
  return def;
}

export interface EventRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
  notes: string | null;
  is_demo: number;
  source: string;
}
export interface MessageRow {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  received_at: string;
  needs_reply: number;
  is_demo: number;
  source: string;
  thread_id?: string | null;
  rfc_message_id?: string | null;
}
export interface NewsRow {
  id: string;
  source: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
  is_demo: number;
}

export const TOOLS = {
  "calendar.list_events": tool({
    name: "calendar.list_events",
    description: "List calendar events in a time window (max 14 days).",
    serviceId: "demo-calendar",
    required: "read",
    input: z.object({ from: z.iso.datetime({ offset: true }), days: z.number().int().min(1).max(14) }),
    run(ctx, input) {
      const to = new Date(new Date(input.from).getTime() + input.days * 86_400_000).toISOString();
      return all<EventRow>(ctx.db, "SELECT * FROM events WHERE source = 'demo' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at", new Date(input.from).toISOString(), to);
    },
    summarize: (o) => `${o.length} events`,
  }),
  "inbox.list_messages": tool({
    name: "inbox.list_messages",
    description: "List recent message headers and short snippets (no full bodies).",
    serviceId: "demo-mail",
    required: "read",
    input: z.object({ limit: z.number().int().min(1).max(25), needsReplyOnly: z.boolean().default(false) }),
    run(ctx, input) {
      return all<MessageRow>(
        ctx.db,
        `SELECT * FROM messages WHERE source = 'demo' ${input.needsReplyOnly ? "AND needs_reply = 1" : ""} ORDER BY received_at DESC LIMIT ?`,
        input.limit,
      );
    },
    summarize: (o) => `${o.length} message headers`,
  }),
  "news.refresh": tool({
    name: "news.refresh",
    description: "Fetch the public news sources the user enabled (allowlisted https feeds only).",
    serviceId: "public-news",
    required: "read",
    input: z.object({}),
    run: (ctx) => refreshFeeds(ctx),
    summarize: (o) => (o.length ? `${o.filter((r) => r.ok).length}/${o.length} sources fetched` : "no live sources enabled"),
  }),
  "news.list_items": tool({
    name: "news.list_items",
    description: "List items from the configured public tech-news sources. Live items are used when any exist; otherwise the sample feed.",
    serviceId: "public-news",
    required: "read",
    input: z.object({ limit: z.number().int().min(1).max(15) }),
    run(ctx, input) {
      const live = all<NewsRow>(ctx.db, "SELECT * FROM news_items WHERE is_demo = 0 ORDER BY published_at DESC LIMIT ?", input.limit);
      // The sample feed stands in for live sources, except in the personal app (never fictional news).
      if (live.length || appMode() === "personal") return live;
      return all<NewsRow>(ctx.db, "SELECT * FROM news_items WHERE is_demo = 1 ORDER BY published_at DESC LIMIT ?", input.limit);
    },
    summarize: (o) => `${o.length} news items (${o.some((n) => !n.is_demo) ? "live feeds" : "sample feed"})`,
  }),
  // Real Google services. Each tool is bound to its own service, so Demo Gmail / Demo Calendar
  // grants never reach real data (and vice versa).
  "gmail.sync": tool({
    name: "gmail.sync",
    description: "Fetch recent Gmail inbox headers (sender, subject, date). Bodies are never requested.",
    serviceId: "gmail",
    required: "read",
    input: z.object({}),
    run: (ctx) => syncGmail(ctx),
    summarize: (o) => `${o.messages} headers synced`,
  }),
  "gmail.list_messages": tool({
    name: "gmail.list_messages",
    description: "List synced Gmail headers.",
    serviceId: "gmail",
    required: "read",
    input: z.object({ limit: z.number().int().min(1).max(25), needsReplyOnly: z.boolean().default(false) }),
    run(ctx, input) {
      return all<MessageRow>(ctx.db, `SELECT * FROM messages WHERE source = 'gmail' ${input.needsReplyOnly ? "AND needs_reply = 1" : ""} ORDER BY received_at DESC LIMIT ?`, input.limit);
    },
    summarize: (o) => `${o.length} Gmail headers`,
  }),
  "gmail.scan_waiting": tool({
    name: "gmail.scan_waiting",
    description: "Find threads where the user wrote last and nobody answered for 3+ days (headers only).",
    serviceId: "gmail",
    required: "read",
    input: z.object({}),
    run: (ctx) => scanWaitingOn(ctx),
    summarize: (o) => `${o.waiting} thread(s) waiting on others`,
  }),
  "gmail.scan_bookings": tool({
    name: "gmail.scan_bookings",
    description: "Find booking confirmations (flights, trains, stays, tables, tickets) from the last 6 months (headers only).",
    serviceId: "gmail",
    required: "read",
    input: z.object({}),
    run: (ctx) => scanBookings(ctx),
    summarize: (o) => `${o.bookings} booking(s)`,
  }),
  "gmail.audit_subscriptions": tool({
    name: "gmail.audit_subscriptions",
    description: "List senders of mail you can unsubscribe from over the last 4 months (headers only). Changes nothing.",
    serviceId: "gmail",
    required: "read",
    input: z.object({}),
    run: (ctx) => auditSubscriptions(ctx),
    summarize: (o) => `${o.senders} sender(s) from ${o.scanned} messages`,
  }),
  "gcal.range": tool({
    name: "gcal.range",
    description: "Read Google Calendar events in any window up to 3 months (titles, times, places). Not stored.",
    serviceId: "google-calendar",
    required: "read",
    input: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
    run: (ctx, input) => fetchCalendarRange(ctx, new Date(input.from), new Date(input.to)),
    summarize: (o) => `${o.length} event(s)`,
  }),
  "gmail.search": tool({
    name: "gmail.search",
    description: "Search Gmail with Gmail's own query syntax (from:, subject:, newer_than:…). Headers only, nothing stored.",
    serviceId: "gmail",
    required: "read",
    input: z.object({ query: z.string().trim().min(1).max(300), max: z.number().int().min(1).max(50).default(20) }),
    run: (ctx, input) => searchGmail(ctx, input.query, input.max),
    summarize: (o) => `${o.length} matching message(s), headers only`,
  }),
  "gmail.read_by_id": tool({
    name: "gmail.read_by_id",
    description: "Read the text of ONE Gmail message by id, on demand (for the local model). Untrusted data, never stored.",
    serviceId: "gmail",
    required: "read",
    input: z.object({ gmailId: z.string().regex(/^[\w-]{1,64}$/) }),
    run: (ctx, input) => readGmailById(ctx, input.gmailId),
    summarize: (o) => `read 1 message (${o.text.length} chars, not stored)`,
  }),
  "gmail.read_message": tool({
    name: "gmail.read_message",
    description: "Read the text of ONE synced Gmail message, on demand. The text is untrusted data and is never stored.",
    serviceId: "gmail",
    required: "read",
    input: z.object({ messageId: z.string().regex(/^gm_[\w-]{1,64}$/) }),
    run: (ctx, input) => readMessageText(ctx, input.messageId),
    summarize: (o) => `read 1 message (${o.text.length} chars, not stored)`,
  }),
  "gcal.sync": tool({
    name: "gcal.sync",
    description: "Fetch Google Calendar events (titles, times, locations) for the next two weeks.",
    serviceId: "google-calendar",
    required: "read",
    input: z.object({}),
    run: (ctx) => syncCalendar(ctx),
    summarize: (o) => `${o.events} events synced`,
  }),
  "gcal.list_events": tool({
    name: "gcal.list_events",
    description: "List synced Google Calendar events in a window (max 14 days).",
    serviceId: "google-calendar",
    required: "read",
    input: z.object({ from: z.iso.datetime({ offset: true }), days: z.number().int().min(1).max(14) }),
    run(ctx, input) {
      const to = new Date(new Date(input.from).getTime() + input.days * 86_400_000).toISOString();
      return all<EventRow>(ctx.db, "SELECT * FROM events WHERE source IN ('google-calendar', 'google-calendar-app') AND starts_at >= ? AND starts_at < ? ORDER BY starts_at", new Date(input.from).toISOString(), to);
    },
    summarize: (o) => `${o.length} Google Calendar events`,
  }),
  "weather.forecast": tool({
    name: "weather.forecast",
    description: "Today's and tomorrow's forecast for the user's chosen city (Open-Meteo).",
    serviceId: "weather",
    required: "read",
    input: z.object({}),
    run: (ctx) => forecast(ctx),
    summarize: (o) => `forecast for ${o.location}${o.cached ? " (cached)" : ""}`,
  }),
  "weather.lookup": tool({
    name: "weather.lookup",
    description: "7-day forecast for a named place, or the user's city when none is given (Open-Meteo, nothing stored).",
    serviceId: "weather",
    required: "read",
    input: z.object({ place: z.string().trim().min(2).max(80).nullable() }),
    run: (ctx, input) => forecastFor(input.place, ctx),
    summarize: (o) => `7-day forecast for ${o.location}`,
  }),
  "web.search": tool({
    name: "web.search",
    description: "Search the web through the user's own SearXNG (no account). Returns titles, links and snippets as untrusted data.",
    serviceId: "web-search",
    required: "read",
    input: z.object({ query: z.string().trim().min(2).max(200) }),
    run: (_ctx, input) => searchWeb(input.query),
    summarize: (o) => `${o.length} web results`,
  }),
  "web.read": tool({
    name: "web.read",
    description: "Read the text of one public https page (public addresses only, 1 MB cap). Untrusted data.",
    serviceId: "web-search",
    required: "read",
    input: z.object({ url: z.string().url().max(500) }),
    run: (_ctx, input) => readPage(input.url, 12_000),
    summarize: (o) => `${o.length} characters of page text`,
  }),
  "knowledge.search": tool({
    name: "knowledge.search",
    description: "Keyword search over the user's selected knowledge notes. Returns passages as untrusted data.",
    serviceId: "demo-notes",
    required: "read",
    input: z.object({ query: z.string().min(2).max(300), k: z.number().int().min(1).max(5).default(3) }),
    async run(ctx, input, agentId) {
      const res = await retrieve(ctx, { query: input.query, provider: "lexical", k: input.k, answer: false }, undefined, agentId);
      return res.passages.map((p) => ({ title: p.title, sourceRef: p.sourceRef, text: p.text, flags: p.flags }));
    },
    summarize: (o) => `${o.length} passages`,
  }),
  "actions.propose": tool({
    name: "actions.propose",
    description: "Propose a draft action (email reply, Gmail draft, calendar event, reminder, webhook call) for the user to review. Never executes it.",
    serviceId: (input) => input.serviceId,
    required: "prepare",
    input: z.object({
      // Demo services, or a user-registered webhook (each webhook is its own service).
      serviceId: z.string().regex(/^(demo-mail|demo-calendar|local-tasks|gmail-drafts|google-calendar-app|hook-[a-z0-9-]{1,40})$/),
      kind: ActionKindSchema,
      title: z.string().min(1).max(200),
      payload: z.record(z.string(), z.unknown()),
      idempotencyKey: z.string().min(1).max(200),
    }),
    run(ctx, input, agentId) {
      const row = proposeAction(ctx, { agentId, ...input });
      return { actionId: row.id, status: row.status };
    },
    summarize: (o) => `action ${o.status}`,
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

export class ToolInputError extends Error {
  readonly code = "INVALID_INPUT";
}

/**
 * The only entry point for agent tool calls (workflows and MCP both use it).
 * Order: budget → schema validation → permission check → run → minimal audit log.
 */
export async function callTool<N extends ToolName>(
  ctx: Ctx,
  agentId: string,
  name: N,
  rawInput: unknown,
  budget: RunBudget,
): Promise<Awaited<ReturnType<(typeof TOOLS)[N]["run"]>>> {
  const def = TOOLS[name] as unknown as ToolDef<z.ZodType, unknown>;
  if (!def) throw new ToolInputError(`Unknown tool`);
  budget.spend(name);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(`Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const serviceId = typeof def.serviceId === "function" ? def.serviceId(parsed.data) : def.serviceId;
  authorize(ctx, agentId, serviceId, def.required, `${name}`);
  const output = await def.run(ctx, parsed.data, agentId);
  logActivity(ctx, {
    actor: agentId,
    kind: def.required === "read" ? "data_access" : "agent_run",
    agentId,
    serviceId,
    outcome: "ok",
    summary: `${name} → ${def.summarize(output)}`,
  });
  return output as Awaited<ReturnType<(typeof TOOLS)[N]["run"]>>;
}
