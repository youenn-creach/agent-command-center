"use client";

import { RequestsCard } from "../Requests";
import { RunningNow } from "../RunningNow";
import { BriefingView } from "../BriefingView";
import { useState } from "react";
import type { SectionProps, Go } from "../Dashboard";
import { Badge, Button, Card, Empty, SectionHeader, Technical, useToast } from "../ui";
import { RemindersCard } from "../Reminders";
import { DoneForYouCard } from "../DoneForYou";
import { ImpactCard } from "../Impact";
import { fmtTime, post, relative } from "../api";
import { ServiceStatus } from "../icons";

export function TodayView({ state, refresh, go }: SectionProps & { go: Go }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { events, waiting, briefing } = state.today;
  const briefingJob = state.jobs.find((j) => j.workflow === "daily_briefing");
  const running = briefingJob?.history.some((h) => h.status === "running");
  const pending = state.actions.filter((a) => a.status === "proposed");
  const blocked = state.jobs.filter((j) => j.status === "blocked" || j.failureStreak >= 3);
  const todayKey = new Date().toDateString();
  const todayEvents = events.filter((e) => new Date(e.starts_at).toDateString() === todayKey);
  const tomorrowEvents = events.filter((e) => new Date(e.starts_at).toDateString() !== todayKey);

  async function runBriefing() {
    if (!briefingJob) return;
    setBusy(true);
    try {
      await post("/api/jobs", { op: "run", id: briefingJob.id });
      toast("Briefing started. The local LLM can take a few minutes on this CPU.", "accent");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader
        title={new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
        description={`Your day at a glance. Agents prepare; you decide. Nothing leaves this machine without your explicit approval${Object.values(state.autopilot.kinds).some(Boolean) ? ", except what you put on autopilot (listed under Done for you)" : ""}.`}
      />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Stat label="Waiting for your approval" value={pending.length} tone={pending.length ? "accent" : "neutral"} onClick={() => go("actions")} />
        <Stat label="Messages waiting on a reply" value={waiting.length} tone="neutral" onClick={() => go("actions")} />
        <Stat label="Still no answer from others" value={state.insights.waiting.length} tone="neutral" onClick={() => go("insights")} />
        <Stat label="Schedules needing attention" value={blocked.length} tone={blocked.length ? "warn" : "neutral"} onClick={() => go("schedules")} />
      </div>
      <ImpactCard impact={state.impact} onOpen={go} />
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card
          title="Daily briefing"
          subtitle={briefing ? `Delivered ${relative(briefing.created_at)} by the Chief of Staff` : "No briefing yet"}
          actions={
            <Button variant="primary" onClick={runBriefing} busy={busy || running} disabled={!briefingJob}>
              {running ? "Running…" : "Run briefing now"}
            </Button>
          }
        >
          {briefing ? (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {briefing.simulated ? <Badge tone="warn">Simulated sources (sample feed)</Badge> : <Badge tone="ok">Live sources</Badge>}
                <Technical>
                  <Badge tone="local">Written by {briefing.provenance.writer}</Badge>
                  <Badge>{briefing.provenance.toolCalls} tool calls</Badge>
                </Technical>
                {briefing.provenance.flaggedItems > 0 && <Badge tone="danger">{briefing.provenance.flaggedItems} item(s) contained instructions — treated as data</Badge>}
              </div>
              <BriefingView body={briefing.body} />
              <Technical>
              <details className="mt-4 rounded-lg bg-panel-2 p-3 text-xs">
                <summary className="cursor-pointer font-medium">How this briefing was made</summary>
                <ol className="mt-2 space-y-1">
                  {briefing.provenance.steps.map((s: { agent: string; tool: string; outcome: string; note: string }, i: number) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <Badge tone={s.outcome === "ok" ? "ok" : s.outcome === "skipped" ? "warn" : "danger"}>{s.outcome}</Badge>
                      <span className="font-medium">{s.agent}</span>
                      <code className="text-muted">{s.tool}</code>
                      <span className="text-muted">— {s.note}</span>
                    </li>
                  ))}
                </ol>
              </details>
              </Technical>
            </>
          ) : (
            <Empty title="No briefing delivered yet">
              The &quot;Morning tech briefing&quot; job runs on weekdays at 08:30 when the worker is running. Use &quot;Run briefing now&quot; to try it.
            </Empty>
          )}
        </Card>
        <div className="space-y-4">
          <RunningNow state={state} />
          <DoneForYouCard done={state.autopilot.done} refresh={refresh} />
          <RemindersCard reminders={state.today.reminders} refresh={refresh} onEmpty={() => go("actions")} />
          <RequestsCard requests={state.requests} go={go} />
          {state.today.weekly && (
            <Card title={state.today.weekly.title} subtitle={`Delivered ${relative(state.today.weekly.created_at)} by the Chief of Staff`}>
              <details>
                <summary className="cursor-pointer text-xs font-medium text-accent">Show the weekly review</summary>
                <div className="mt-2">
                  <BriefingView body={state.today.weekly.body} />
                </div>
              </details>
            </Card>
          )}
          <Card title="Agenda" subtitle={<SourceLine state={state} ids={["demo-calendar", "google-calendar"]} />}>
            {events.length === 0 ? (
              <Empty title="Nothing scheduled" />
            ) : (
              <div className="space-y-3">
                <EventList label="Today" items={todayEvents} />
                {tomorrowEvents.length > 0 && <EventList label="Tomorrow" items={tomorrowEvents} />}
              </div>
            )}
          </Card>
          <Card title="Waiting on you" subtitle={<SourceLine state={state} ids={["demo-mail", "gmail"]} />}>
            {waiting.length === 0 ? (
              <Empty title="Inbox zero" />
            ) : (
              <ul className="space-y-2">
                {waiting.map((m) => (
                  <li key={m.id} className="text-sm">
                    <p className="font-medium">{m.subject}</p>
                    <p className="text-xs text-muted">
                      {m.sender} · {relative(m.received_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function EventList({ label, items }: { label: string; items: { id: string; title: string; starts_at: string; location: string | null }[] }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <ul className="space-y-1.5">
        {items.map((e) => (
          <li key={e.id} className="flex gap-3 text-sm">
            <span className="w-12 shrink-0 font-mono text-xs text-muted">{fmtTime(e.starts_at)}</span>
            <span>
              {e.title}
              {e.location && <span className="block text-xs text-muted">{e.location}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, tone, onClick }: { label: string; value: number; tone: "accent" | "warn" | "neutral"; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-line bg-panel p-4 text-left hover:bg-panel-2">
      <p className={`text-2xl font-semibold ${tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : ""}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </button>
  );
}

/** Shows which services feed a card, with their live connection state. */
function SourceLine({ state, ids }: { state: SectionProps["state"]; ids: string[] }) {
  return (
    <span className="mt-1.5 block space-y-1">
      {ids
        .map((id) => state.services.find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => (
          <ServiceStatus key={s.id} service={s} compact />
        ))}
    </span>
  );
}
