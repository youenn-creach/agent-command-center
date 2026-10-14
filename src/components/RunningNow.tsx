"use client";

import { useEffect, useState } from "react";
import type { DashboardState } from "@/server/state";
import { Badge, Card, Spinner } from "./ui";

const since = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};
/** One line per model and kind of call, with how many run and since when the oldest. */
function groupCalls(calls: DashboardState["llm"]["active"]) {
  const by = new Map<string, { model: string; task: string; startedAt: string; count: number }>();
  for (const c of calls) {
    const k = `${c.model}|${c.task}`;
    const cur = by.get(k);
    if (!cur) by.set(k, { ...c, count: 1 });
    else {
      cur.count++;
      if (c.startedAt < cur.startedAt) cur.startedAt = c.startedAt;
    }
  }
  return [...by.values()];
}
const gb = (mb: number) => `${(mb / 1000).toFixed(1)} GB`;

function Meter({ label, percent, detail, warn }: { label: string; percent: number; detail: string; warn?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="truncate text-muted tabular-nums">{detail}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)}>
        <div className={`h-full rounded-full ${warn ? "bg-amber-500" : "bg-accent"}`} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
      </div>
    </div>
  );
}

/**
 * Everything running right now: the model's calls, requests from Ctrl+K with their stage, scheduled runs,
 * and what the computer is doing (CPU, memory, the model in memory) with a plain-language bottleneck.
 * When nothing runs it shrinks to one quiet line.
 */
export function RunningNow({ state }: { state: DashboardState }) {
  const [now, setNow] = useState(() => Date.now());
  const running = {
    calls: state.llm.active,
    requests: state.requests.filter((r) => r.state === "working"),
    jobs: state.jobs.flatMap((j) => j.history.filter((h) => h.status === "running").map((h) => ({ name: j.name, startedAt: h.started_at }))),
  };
  const busy = running.calls.length + running.requests.length + running.jobs.length > 0;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const r = state.resources;
  const memPercent = Math.round((r.memory.usedMB / r.memory.totalMB) * 100);
  const resources = (
    <div className="grid gap-2">
      <Meter label="CPU" percent={r.cpu.percent} detail={`${r.cpu.percent}% of ${r.cpu.cores} cores`} warn={r.cpu.percent >= 85} />
      <Meter label="Memory" percent={memPercent} detail={`${gb(r.memory.usedMB)} of ${gb(r.memory.totalMB)}${r.memory.swapUsedMB > 300 ? ` · ${gb(r.memory.swapUsedMB)} swapped` : ""}`} warn={r.memory.availableMB < 1000} />
    </div>
  );

  if (!busy) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-panel-2 px-3 py-2 text-xs text-muted" aria-label="Nothing is running">
        <span className="font-medium text-ink">Idle</span>
        <span>CPU {r.cpu.percent}% · memory {gb(r.memory.usedMB)} of {gb(r.memory.totalMB)}</span>
        <span>· {r.model ? `${r.model.name.split("/").at(-1)} loaded in memory${r.model.untilIso ? ` until ${new Date(r.model.untilIso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}` : "no model in memory"}</span>
      </p>
    );
  }
  return (
    <Card title="Running now" subtitle="What the assistant is doing at this moment, and what is slowing it down.">
      <ul className="space-y-2 text-sm">
        {running.requests.map((q) => (
          <li key={q.id} className="rounded-md bg-panel-2 px-2.5 py-2">
            <p className="flex items-start gap-2">
              <Spinner />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{q.text}</span>
                <span className="block text-xs text-muted">{q.status}</span>
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{since(q.created_at, now)}</span>
            </p>
          </li>
        ))}
        {running.jobs.map((j, i) => (
          <li key={`${j.name}-${i}`} className="flex items-start gap-2 rounded-md bg-panel-2 px-2.5 py-2">
            <Spinner />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{j.name}</span>
              <span className="block text-xs text-muted">Scheduled task running</span>
            </span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{since(j.startedAt, now)}</span>
          </li>
        ))}
        {groupCalls(running.calls).map((c) => (
          <li key={`${c.model}-${c.task}`} className="flex items-center gap-2 text-xs text-muted">
            <Badge tone="accent">Model</Badge>
            <span className="truncate">
              {c.model.split("/").at(-1)} is {c.task === "interactive" ? "answering" : "reading and writing"}
              {c.count > 1 ? ` (${c.count} calls)` : ""}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">{since(c.startedAt, now)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 border-t border-line pt-3">
        {resources}
        {r.top.length > 0 && <p className="mt-2 text-xs text-muted">Busiest on this computer: {r.top.map((p) => `${p.name} ${p.percent}%`).join(" · ")}</p>}
        <p className={`mt-2 rounded-md px-2.5 py-1.5 text-xs ${r.bottleneck ? "bg-amber-500/10 text-ink" : "bg-panel-2 text-muted"}`} role="status">
          <span className="font-medium">Bottleneck: </span>
          {r.bottleneck?.text ?? "none right now: the computer has room to spare."}
        </p>
      </div>
    </Card>
  );
}
