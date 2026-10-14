import { all, getSetting, one, type Ctx } from "./db";
import { listActions } from "./approvals";
import { listJobs, jobHistory, nextRuns } from "./scheduler/scheduler";
import { listAgents, listServices, permissionMatrix } from "./policy/permissions";
import { knowledgeStats, listDocuments, liveModeStatus, recentRetrievals } from "./retrieval/knowledge";
import { languageModel, ollamaHealth, selectedModel } from "./llm";
import { LANGS, LANG_NAMES } from "./lang";
import { activeLlmCalls, finishPendingOffload, offloadPending } from "./llmRuntime";
import { appMode, DEMO_ONLY_WORKFLOWS, demoRowsFilter, hiddenReason } from "./mode";
import { listFacts } from "./memory";
import { listRequests } from "./requests";
import { systemResources } from "./resources";
import { listInsights } from "./insights";
import { impactSummary } from "./impact";
import { NOTIFY_KINDS, NOTIFY_LABELS, notificationSettings } from "./notify";
import { calendarMode } from "./calendarMode";
import { publicConfig } from "./config";
import type { EventRow, MessageRow } from "./tools/registry";
import { listSources } from "./news/feeds";
import { listReminders } from "./reminders";
import { WORKFLOW_CATALOG } from "./agents/catalog";
import { connectionInfo } from "./connectors/google";
import { getRetention } from "./retention";
import { listWebhooks } from "./connectors/webhooks";
import { getLocation } from "./connectors/weather";

/**
 * Everything the dashboard renders, in one read. This is the *user's* view of their own data
 * (not an agent tool call), so it is not gated by agent permissions — but it never includes
 * secrets, and message content is limited to the stored header + snippet.
 */
export async function dashboardState(ctx: Ctx) {
  const now = ctx.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 2 * 86_400_000);

  // Services (and the jobs that need them) that aren't part of this instance are left out entirely.
  const allServices = listServices(ctx);
  // In the personal app, shared services drop their demo wording (no sample feed, no fictional notes there).
  const PERSONAL_LABELS: Record<string, { name: string; description: string }> = {
    "public-news": { name: "Public news", description: "The public RSS sources you enable in Settings." },
    "demo-notes": { name: "Notes & knowledge", description: "Notes you add or import (CSV, Markdown). Stored on this machine." },
  };
  const services = allServices.filter((s) => !hiddenReason(s)).map((s) => (appMode() === "personal" && PERSONAL_LABELS[s.id] ? { ...s, ...PERSONAL_LABELS[s.id] } : s));
  const hiddenIds = new Set(allServices.filter((s) => hiddenReason(s)).map((s) => s.id));
  const personal = appMode() === "personal";
  // In the personal app: no fictional example jobs, and seeded jobs describe the real sources they use.
  const REAL_SOURCE: Record<string, string> = { "Public news (sample feed)": "Public news", "Demo Calendar": "Google Calendar", "Demo Gmail (headers only)": "Gmail (headers only)" };
  const jobs = listJobs(ctx)
    .filter((j) => !(personal && DEMO_ONLY_WORKFLOWS.has(j.workflow)))
    .map((j) => {
      const recent = jobHistory(ctx, j.id, 10);
      // Consecutive failed runs, newest first: 3+ means the job needs attention.
      let failureStreak = 0;
      for (const r of recent) {
        if (r.status === "failed") failureStreak++;
        else if (r.status !== "running") break;
      }
      return {
        ...j,
        simulated: personal ? 0 : j.simulated,
        sources: (JSON.parse(j.sources) as string[]).map((src) => (personal ? (REAL_SOURCE[src] ?? src) : src)),
        requirements: JSON.parse(j.requirements) as { agentId: string; serviceId: string; level: string }[],
        upcoming: j.status === "active" && j.next_run_at ? nextRuns(j.cron, j.timezone, now, 3).map((d) => d.toISOString()) : [],
        history: recent.slice(0, 8),
        failureStreak,
      };
    });

  // Proposals on demo services (made before switching to the personal app) can't run here: not shown.
  const actions = listActions(ctx).filter((a) => !(personal && a.is_demo));
  const agents = listAgents(ctx).map((a) => ({
    ...a,
    pendingApprovals: actions.filter((x) => x.agent_id === a.id && x.status === "proposed").length,
    nextRun: jobs.filter((j) => j.agent_id === a.id && j.status === "active" && j.next_run_at).map((j) => j.next_run_at!).sort()[0] ?? null,
    jobs: jobs.filter((j) => j.agent_id === a.id).map((j) => j.name),
  }));

  type BriefingRow = { id: string; created_at: string; title: string; body: string; provenance: string; simulated: number; kind: string };
  // The personal app only shows briefings made from real sources: no sample news, and none of the
  // demo-only tools (demo calendar and inbox) in their recorded steps.
  const realOnly = personal
    ? ` AND simulated = 0 AND NOT EXISTS (SELECT 1 FROM json_each(provenance, '$.steps') s WHERE json_extract(s.value, '$.tool') IN ('calendar.list_events', 'inbox.list_messages'))`
    : "";
  const latestBriefing = one<BriefingRow>(ctx.db, `SELECT * FROM briefings WHERE kind = 'daily'${realOnly} ORDER BY created_at DESC LIMIT 1`);
  const weekly = one<BriefingRow>(ctx.db, `SELECT * FROM briefings WHERE kind = 'weekly' AND created_at >= ?${realOnly} ORDER BY created_at DESC LIMIT 1`, new Date(now.getTime() - 8 * 86_400_000).toISOString());

  const model = selectedModel(ctx);
  const ollama = await ollamaHealth(model);

  // A pending "offload when idle" whose last call crashed would otherwise wait forever.
  if (offloadPending(ctx) && activeLlmCalls(ctx).length === 0) await finishPendingOffload(ctx);
  return {
    now: now.toISOString(),
    config: publicConfig(),
    ui: { simple: getSetting(ctx.db, "ui.simple") === "1" },
    memory: listFacts(ctx),
    requests: listRequests(ctx),
    insights: listInsights(ctx),
    impact: impactSummary(ctx),
    calendar: { mode: calendarMode(ctx) },
    notifications: { ...notificationSettings(ctx), available: NOTIFY_KINDS.map((k) => ({ kind: k, label: NOTIFY_LABELS[k] })) },
    llm: {
      // `model` = background choice (kept for older UI code paths); `interactive` = Showcase answers.
      model,
      background: model,
      interactive: selectedModel(ctx, "interactive"),
      /** Calls running right now (web server or worker): drives the "thinking" indicator. */
      active: activeLlmCalls(ctx).map(({ model, task, startedAt }) => ({ model, task, startedAt })),
      offloadPending: offloadPending(ctx),
      /** Optional model per email language for reply drafts (null = the background model). */
      byLanguage: LANGS.map((lang) => ({ lang, name: LANG_NAMES[lang], model: languageModel(ctx, lang) })),
      speeds: Object.fromEntries(
        ollama.models.map((m) => [m.name, parseJson<{ loadSeconds: number | null; promptTokensPerSec: number | null; outputTokensPerSec: number | null; testedAt: string }>(getSetting(ctx.db, `llm.speed.${m.name}`))]),
      ),
    },
    health: { ollama },
    resources: await systemResources(activeLlmCalls(ctx).length > 0 || ollama.running && listRequests(ctx).some((r) => r.state === "working")),
    today: {
      events: all<EventRow>(ctx.db, `SELECT * FROM events WHERE starts_at >= ? AND starts_at < ?${demoRowsFilter()} ORDER BY starts_at`, dayStart.toISOString(), dayEnd.toISOString()),
      waiting: all<MessageRow>(ctx.db, `SELECT * FROM messages WHERE needs_reply = 1${demoRowsFilter()} ORDER BY received_at DESC`),
      briefing: latestBriefing ? { ...latestBriefing, provenance: JSON.parse(latestBriefing.provenance) } : null,
      reminders: listReminders(ctx),
      weekly: weekly ? { ...weekly, provenance: JSON.parse(weekly.provenance) } : null,
    },
    actions: actions.map((a) => ({ ...a, payload: JSON.parse(a.payload) as Record<string, unknown> })),
    outbox: all(ctx.db, "SELECT * FROM simulated_outbox ORDER BY created_at DESC LIMIT 20"),
    agents,
    jobs,
    services,
    matrix: permissionMatrix(ctx).map((row) => ({ ...row, cells: row.cells.filter((c) => !hiddenIds.has(c.serviceId)) })),
    knowledge: { stats: knowledgeStats(ctx), documents: listDocuments(ctx), recent: recentRetrievals(ctx, 5) },
    live: liveModeStatus(ctx),
    google: connectionInfo(ctx),
    retention: getRetention(ctx),
    webhooks: listWebhooks(ctx),
    weather: { location: getLocation(ctx) },
    catalog: WORKFLOW_CATALOG.map(({ workflow, name, description, defaultCron, destination }) => ({ workflow, name, description, defaultCron, destination })),
    news: { sources: listSources(ctx), liveItems: one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM news_items WHERE is_demo = 0")!.n },
    worker: workerStatus(getSetting(ctx.db, "worker.heartbeat"), now),
    evaluation: parseJson<{
      ranAt: string;
      queries: number;
      questions?: string[];
      results: Record<string, { recallAt1: number; recallAt3: number; mrr: number; avgMs: number; queries?: number; ranAt?: string; ranks?: (number | null)[] }>;
    }>(getSetting(ctx.db, "eval.latest")),
  };
}

export type DashboardState = Awaited<ReturnType<typeof dashboardState>>;

function parseJson<T>(value: string | undefined): T | null {
  try {
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function workerStatus(heartbeat: string | undefined, now: Date) {
  return { lastHeartbeat: heartbeat ?? null, running: Boolean(heartbeat && now.getTime() - new Date(heartbeat).getTime() < 120_000) };
}
