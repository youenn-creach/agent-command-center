"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardState } from "@/server/state";
import { Badge, cx, SimpleModeProvider, ToastProvider, useToast } from "./ui";
import { ModelIcon, NavIcon, ServiceIcon, ServiceStatus, StatusLight } from "./icons";
import { agentLight, relative, stepLabel } from "./api";
import { TodayView } from "./sections/Today";
import { ActionQueueView } from "./sections/ActionQueue";
import { AgentsView } from "./sections/Agents";
import { SchedulesView } from "./sections/Schedules";
import { PermissionsView } from "./sections/Permissions";
import { ShowcaseView } from "./sections/Showcase";
import { KnowledgeView } from "./sections/Knowledge";
import { ActivityView } from "./sections/Activity";
import { SettingsView } from "./sections/Settings";
import { InsightsView } from "./sections/Insights";
import { CommandBar } from "./CommandBar";
import { ThemeToggle } from "./ThemeToggle";

export type SectionProps = { state: DashboardState; refresh: () => Promise<void> };

const SECTIONS = [
  { id: "today", label: "Today" },
  { id: "actions", label: "Action Queue" },
  { id: "insights", label: "Inbox insights" },
  { id: "agents", label: "Agents" },
  { id: "schedules", label: "Scheduled Agents" },
  { id: "permissions", label: "Connections & Permissions" },
  { id: "tech", label: "Under the hood" },
  { id: "knowledge", label: "Knowledge & Data" },
  { id: "activity", label: "Activity Log" },
  { id: "settings", label: "Settings" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export function Dashboard() {
  return (
    <ToastProvider>
      <DashboardInner />
    </ToastProvider>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  BAD_STATE: "That sign-in attempt was expired or already used. Start again.",
  DENIED: "Google sign-in was cancelled or refused. Nothing was connected.",
  SCOPE: "Google did not grant exactly the read-only permission requested, so nothing was connected.",
  TOKEN: "Google did not return a valid token. Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.",
  NOT_CONFIGURED: "Google sign-in is not configured.",
};

function DashboardInner() {
  const toast = useToast();
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("today");
  const [navOpen, setNavOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setState(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    // The URL hash selects the section (deep links, back/forward, manual edits).
    const sync = () => {
      // "#showcase" was this section's old name; keep old links working.
      const raw = window.location.hash.slice(1);
      const fromHash = (raw === "showcase" ? "tech" : raw) as SectionId;
      if (SECTIONS.some((s) => s.id === fromHash)) setSection(fromHash);
    };
    // Runs after hydration: read the hash and load data in a callback, not during the effect body.
    const first = setTimeout(() => {
      sync();
      void refresh();
      // Result of a Google sign-in redirect: show it once, then clean the URL.
      const params = new URLSearchParams(window.location.search);
      const connected = params.get("connected");
      const oauthError = params.get("oauth_error");
      const CONNECTED: Record<string, string> = {
        gmail: "Gmail connected (read-only).",
        "google-calendar": "Google Calendar connected (read-only).",
        "gmail-drafts": "Gmail drafts connected (drafts only, after your approval).",
        "google-calendar-app": "App calendar connected (only its own calendar, after your approval).",
      };
      if (connected) toast(`${CONNECTED[connected] ?? "Connected."} Access stays None until you grant it below.`, "ok");
      if (oauthError) toast(OAUTH_ERRORS[oauthError] ?? "Google sign-in failed.", "danger");
      if (connected || oauthError) history.replaceState(null, "", window.location.pathname + window.location.hash);
    }, 0);
    window.addEventListener("hashchange", sync);
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", sync);
    };
  }, [refresh, toast]);

  const busy = state?.jobs.some((j) => j.history.some((h) => h.status === "running")) || state?.agents.some((a) => a.status === "running") || !!state?.llm.active.length || !!state?.requests.some((r) => r.state === "working");

  // Announce runs that finish while the page is open — fast ones (milliseconds) included, which a
  // "was running, now done" check would miss. Runs that already existed on first load are not announced.
  const announcedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!state) return;
    const finished = state.jobs.flatMap((job) => job.history.filter((r) => r.status !== "running").map((r) => ({ job, run: r })));
    if (!announcedRef.current) {
      announcedRef.current = new Set(finished.map((f) => f.run.id));
      return;
    }
    for (const { job, run } of finished) {
      if (announcedRef.current.has(run.id)) continue;
      announcedRef.current.add(run.id);
      const tone = run.status === "succeeded" ? "ok" : run.status === "blocked" ? "warn" : "danger";
      toast(`${job.name}: ${run.status}${run.message ? ` — ${run.message.slice(0, 120)}` : ""}`, tone);
    }
  }, [state, toast]);
  // Poll faster while something runs; not at all while the tab is hidden (refresh on return).
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, busy ? 3000 : 20000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [busy, refresh]);

  const go = (id: SectionId) => {
    setSection(id);
    setNavOpen(false);
    history.replaceState(null, "", `#${id}`);
    document.getElementById("main")?.focus();
  };

  const pending = state?.actions.filter((a) => a.status === "proposed" || a.status === "approved").length ?? 0;
  const blocked = state?.jobs.filter((j) => j.status === "blocked" || j.failureStreak >= 3).length ?? 0;
  const workerFresh = state?.worker.running;

  const simple = state?.ui.simple ?? false;

  return (
    <SimpleModeProvider value={simple}>
    <div className="flex min-h-screen overflow-x-clip">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-panel focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className={cx("fixed inset-y-0 left-0 z-30 w-64 shrink-0 border-r border-line bg-panel p-4 transition-transform md:static md:translate-x-0", navOpen ? "translate-x-0" : "-translate-x-full")}>
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white dark:text-[#0c1018]">AC</span>
            <div>
              <p className="text-sm font-semibold leading-tight">Agent Command Center</p>
              <p className="text-[11px] text-muted">Personal mission control</p>
            </div>
          </div>
        </div>
        <nav aria-label="Sections" className="space-y-0.5">
          {SECTIONS.filter((s) => !(simple && s.id === "tech")).map((s) => (
            <button
              key={s.id}
              onClick={() => go(s.id)}
              aria-current={section === s.id ? "page" : undefined}
              className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm", section === s.id ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-panel-2 hover:text-ink")}
            >
              <NavIcon id={s.id} />
              <span className="flex-1">{s.label}</span>
              {s.id === "actions" && pending > 0 && <Badge tone="accent">{pending}</Badge>}
              {s.id === "insights" && (state?.insights.waiting.length ?? 0) > 0 && <Badge>{state!.insights.waiting.length}</Badge>}
              {s.id === "schedules" && blocked > 0 && <Badge tone="warn">{blocked}</Badge>}
            </button>
          ))}
        </nav>
        {state && (
          <div className="mt-6 space-y-3">
            <button onClick={() => go("agents")} className="block w-full rounded-lg border border-line bg-panel-2 p-3 text-left hover:border-accent" aria-label="Agents — open Agents">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Agents</p>
              <ul className="space-y-1.5">
                {state.agents.map((a) => (
                  <li key={a.id}>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{a.name}</span>
                      <StatusLight compact {...agentLight(a)} />
                    </span>
                    {a.status === "running" && a.current_step && <span className="block truncate text-[11px] text-muted">{stepLabel(a.current_step)}…</span>}
                  </li>
                ))}
              </ul>
            </button>
            <button onClick={() => go("permissions")} className="block w-full rounded-lg border border-line bg-panel-2 p-3 text-left hover:border-accent" aria-label="Connections — open Connections & Permissions">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Connections</p>
              <ul className="space-y-1.5">
                {[...state.services].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "real" ? -1 : 1)).map((s) => (
                  <li key={s.id}>
                    <ServiceStatus service={s} compact />
                  </li>
                ))}
              </ul>
              {!simple && (
                <>
                  <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Optional cloud services</p>
                  <ul className="space-y-1.5">
                    {(["atlas", "voyage"] as const).map((id) => (
                      <li key={id} className="flex items-center gap-2">
                        <ServiceIcon id={id} size={15} />
                        <span className="flex-1 text-[11px]">{id === "atlas" ? "MongoDB Atlas" : "Voyage AI"}</span>
                        <StatusLight compact {...(state.live.enabled ? { state: "active", label: "Live" } : state.live.configured ? { state: "idle", label: "Off" } : { state: "off", label: "Not set up" })} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </button>
            <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 p-3 text-[11px] text-muted">
              <p className="mb-1 font-semibold uppercase tracking-wide">{simple ? "Status" : "Runtime"}</p>
              <RuntimeModels state={state} simple={simple} onOpen={() => go("settings")} />
              <p className="flex items-center justify-between gap-2">
                <span>{simple ? "Scheduled tasks" : "Scheduler worker"}</span>
                <StatusLight compact {...(workerFresh ? { state: "active", label: "Running" } : { state: "idle", label: state.worker.lastHeartbeat ? `Seen ${relative(state.worker.lastHeartbeat)}` : "Not started" })} />
              </p>
              {!simple && <p>Timezone · {state.config.timezone}</p>}
            </div>
          </div>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          Personal project. Not affiliated with or endorsed by MongoDB, Inc. or Voyage AI.
          {state?.config.mode === "demo" ? " All data shown is fictional demo data." : state?.config.mode === "mixed" ? " Demo services hold fictional data." : ""}
        </p>
      </aside>
      {navOpen && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setNavOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur md:flex-nowrap md:px-8">
          <button className="rounded-lg border border-line px-2 py-1 text-sm md:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            ☰
          </button>
          <h1 className="hidden text-sm font-medium text-muted lg:block">{SECTIONS.find((s) => s.id === section)?.label}</h1>
          <CommandBar go={go} refresh={refresh} />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ThemeToggle />
            {state?.config.mode === "personal" ? (
              <Badge tone="ok" title="Your own accounts only. Demo services and fictional data are hidden here.">Personal</Badge>
            ) : state?.config.mode === "demo" ? (
              <>
                <Badge tone="warn" title="Everything you see is fictional seeded data. Real accounts can't be connected here.">DEMO DATA</Badge>
                <Badge tone="local" title="External actions are simulated: approved actions write to a local outbox only.">Simulated actions</Badge>
              </>
            ) : (
              <Badge tone="warn" title="Demo services hold fictional data; services marked “your account” are real.">Demo + personal</Badge>
            )}
            {state?.config.peerUrl && (
              <a className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-muted hover:border-accent hover:text-ink" href={state.config.peerUrl} title="Open the other instance (separate data)">
                {state.config.mode === "demo" ? "Open my app ↗" : "Open the demo ↗"}
              </a>
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none md:px-8">
          {error && <div className="mb-4 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">Could not load dashboard: {error}</div>}
          {!state ? (
            <div className="grid gap-4 md:grid-cols-3" aria-busy>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-32 animate-pulse rounded-xl border border-line bg-panel" />
              ))}
            </div>
          ) : (
            <>
              {section === "today" && <TodayView state={state} refresh={refresh} go={go} />}
              {section === "actions" && <ActionQueueView state={state} refresh={refresh} go={go} />}
              {section === "insights" && <InsightsView state={state} refresh={refresh} />}
              {section === "agents" && <AgentsView state={state} refresh={refresh} />}
              {section === "schedules" && <SchedulesView state={state} refresh={refresh} />}
              {section === "permissions" && <PermissionsView state={state} refresh={refresh} />}
              {section === "tech" && <ShowcaseView state={state} refresh={refresh} />}
              {section === "knowledge" && <KnowledgeView state={state} refresh={refresh} />}
              {section === "activity" && <ActivityView state={state} refresh={refresh} />}
              {section === "settings" && <SettingsView state={state} refresh={refresh} />}
            </>
          )}
        </main>
      </div>
    </div>
    </SimpleModeProvider>
  );
}

export type Go = (id: SectionId) => void;

/** Local models in the sidebar: one row per task model, with its family mark and a spinner while it generates. */
function RuntimeModels({ state, simple, onOpen }: { state: DashboardState; simple: boolean; onOpen: () => void }) {
  const ready = state.health.ollama.running && state.health.ollama.modelInstalled;
  const light = ready ? { state: "active" as const, label: simple ? "Ready" : "Local" } : { state: "idle" as const, label: state.health.ollama.running ? "Not pulled" : simple ? "Off" : "Ollama off" };
  const models = [...new Set([state.llm.background, state.llm.interactive])];
  const thinking = (m: string) => state.llm.active.some((c) => c.model === m);
  if (simple) {
    const busy = state.llm.active.length > 0;
    return (
      <p className="flex items-center justify-between gap-2">
        <button className="flex min-w-0 items-center gap-1.5 text-left hover:text-ink" onClick={onOpen}>
          <ModelIcon model={state.llm.active[0]?.model ?? state.llm.background} size={13} thinking={busy} />
          {busy ? "Assistant is writing…" : "Assistant"}
        </button>
        <StatusLight compact {...light} />
      </p>
    );
  }
  return (
    <>
      {models.map((m, i) => (
        <p key={m} className="flex items-center justify-between gap-2">
          <button className="flex min-w-0 items-center gap-1.5 text-left hover:text-ink" onClick={onOpen} title={`${m === state.llm.background ? "Background" : ""}${m === state.llm.background && m === state.llm.interactive ? " + " : ""}${m === state.llm.interactive ? "Interactive" : ""}: ${m}`}>
            <ModelIcon model={m} size={13} thinking={thinking(m)} />
            <span className="truncate">{m.split("/").at(-1)}</span>
          </button>
          {i === 0 && <StatusLight compact {...light} />}
        </p>
      ))}
    </>
  );
}
