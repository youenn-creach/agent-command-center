"use client";

import { useEffect, useState } from "react";
import type { SectionProps } from "../Dashboard";
import { Badge, Button, Card, Field, inputCls, SectionHeader, useToast } from "../ui";
import { LEVEL_LABEL, describeSchedule, fmtDateTime, post, relative } from "../api";

type Job = SectionProps["state"]["jobs"][number];

export function SchedulesView({ state, refresh }: SectionProps) {
  const workerFresh = state.worker.running;
  return (
    <div>
      <SectionHeader
        title="Scheduled Agents"
        description="Schedules are stored in the local database, not the browser, so they survive closing this tab. They fire while the scheduler worker runs. Each run re-checks permissions first; if access was revoked, the job blocks and explains why instead of running."
      />
      {!workerFresh && (
        <div className="mb-4 rounded-lg border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
          The scheduler worker is not running, so scheduled times will be missed (one catch-up run happens when it starts — missed slots are not replayed). Start it with <code>npm run worker</code>. &quot;Run now&quot; works without it.
        </div>
      )}
      <NewSchedule state={state} refresh={refresh} />
      <div className="space-y-4">
        {state.jobs.map((j) => (
          <JobCard key={j.id} job={j} state={state} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}

function JobCard({ job, state, refresh }: { job: Job; state: SectionProps["state"]; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [patch, setPatch] = useState({ name: job.name, cron: job.cron, timezone: job.timezone });
  const running = job.history.some((h) => h.status === "running");
  const once = /^\d{4}-\d{2}-\d{2}T/.test(job.cron);
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;

  async function op(body: Record<string, unknown>, ok: string) {
    setBusy(String(body.op));
    try {
      await post("/api/jobs", { id: job.id, ...body });
      toast(ok, "ok");
      setEditing(false);
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  const statusTone = job.status === "active" ? "ok" : job.status === "paused" ? "neutral" : "warn";
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{job.name}</p>
            <Badge tone={statusTone}>{running ? "running" : job.status}</Badge>
            {job.simulated ? <Badge tone="warn" title="Runs against seeded sample data, not live sources">simulated sources</Badge> : <Badge tone="ok">live sources</Badge>}
            {once && <Badge>one-time</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{job.purpose}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={busy === "run" || running} onClick={() => op({ op: "run" }, "Run started — progress shows below")}>
            Run now
          </Button>
          {job.status === "paused" ? (
            <Button busy={busy === "resume"} onClick={() => op({ op: "resume" }, "Resumed")}>
              Resume
            </Button>
          ) : (
            <Button busy={busy === "pause"} onClick={() => op({ op: "pause" }, "Paused")}>
              Pause
            </Button>
          )}
          <Button variant="ghost" onClick={() => setEditing(!editing)}>
            Edit
          </Button>
          <Button variant="ghost" busy={busy === "delete"} disabled={running} onClick={() => confirm(`Delete the schedule "${job.name}" and its history?`) && op({ op: "delete" }, "Schedule deleted")}>
            Delete
          </Button>
        </div>
      </div>

      {job.failureStreak >= 3 && (
        <p className="mt-2 rounded-md bg-danger-soft px-2 py-1 text-xs text-danger">
          The last {job.failureStreak} runs failed. Check the history below; the latest error is “{job.history.find((h) => h.status === "failed")?.message ?? "unknown"}”.
        </p>
      )}
      {job.status_reason && job.status !== "active" && (
        <p className={`mt-2 rounded-md px-2 py-1 text-xs ${job.status === "blocked" ? "bg-warn-soft text-warn" : "bg-panel-2 text-muted"}`}>{job.status_reason}</p>
      )}

      {editing && (
        <div className="mt-3 grid gap-2 rounded-lg bg-panel-2 p-3 sm:grid-cols-3">
          <Field label="Name">
            <input className={inputCls} value={patch.name} onChange={(e) => setPatch({ ...patch, name: e.target.value })} />
          </Field>
          <Field label="Schedule (cron, or ISO date-time for one-time)" hint="e.g. 30 8 * * 1-5 = weekdays 08:30">
            <input className={`${inputCls} font-mono`} value={patch.cron} onChange={(e) => setPatch({ ...patch, cron: e.target.value })} />
          </Field>
          <Field label="Timezone (IANA)" hint="e.g. Europe/Paris">
            <input className={inputCls} value={patch.timezone} onChange={(e) => setPatch({ ...patch, timezone: e.target.value })} />
          </Field>
          <div className="sm:col-span-3">
            <Button variant="primary" busy={busy === "edit"} onClick={() => op({ op: "edit", patch }, "Schedule updated")}>
              Save
            </Button>
          </div>
        </div>
      )}

      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-muted">Schedule</dt>
          <dd>
            {describeSchedule(job.cron)}
            <br />
            <span className="text-muted">{job.timezone}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Next run</dt>
          <dd>
            {job.status !== "active" ? "— (not active)" : job.next_run_at ? `${fmtDateTime(job.next_run_at, job.timezone)} (${relative(job.next_run_at)})` : "Completed — no further runs"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Sources → destination</dt>
          <dd>
            {job.sources.join(", ") || "—"} → {job.destination}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Needs</dt>
          <dd>
            {job.requirements.map((r) => (
              <span key={`${r.agentId}-${r.serviceId}`} className="block">
                {agentName(r.agentId)}: {LEVEL_LABEL[r.level]} on {r.serviceId}
              </span>
            ))}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted">
        Last result: {job.last_result ?? "never run"} {job.last_run_at && `(${relative(job.last_run_at)})`} · Runs as {agentName(job.agent_id)} · Retries: up to {job.max_attempts} attempts
      </p>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-medium">History ({job.history.length})</summary>
        {job.history.length === 0 ? (
          <p className="mt-2 text-muted">No runs yet.</p>
        ) : (
          // Scrolls on its own at phone width; focusable so the keyboard can scroll it too (axe scrollable-region-focusable).
          <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label={`Run history of ${job.name}`}>
          <table className="w-full text-left">
            <thead className="text-muted">
              <tr>
                <th className="py-1 font-medium">Started</th>
                <th className="font-medium">Trigger</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Attempts</th>
                <th className="font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {job.history.map((h) => (
                <tr key={h.id} className="border-t border-line align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtDateTime(h.started_at)}</td>
                  <td className="pr-2">{h.trigger}</td>
                  <td className="pr-2">
                    <Badge tone={h.status === "succeeded" ? "ok" : h.status === "running" ? "accent" : h.status === "blocked" ? "warn" : "danger"}>{h.status}</Badge>
                  </td>
                  <td className="pr-2">{h.attempt}</td>
                  <td className="text-muted">{h.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </details>
    </Card>
  );
}

function NewSchedule({ state, refresh }: { state: SectionProps["state"]; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const first = state.catalog[0];
  const [form, setForm] = useState({ workflow: first?.workflow ?? "", name: first?.name ?? "", cron: first?.defaultCron ?? "", timezone: state.config.timezone });
  const [preview, setPreview] = useState<{ next?: string[]; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const entry = state.catalog.find((c) => c.workflow === form.workflow);

  // Live preview of the next runs, debounced, validated by the server (same rules as saving).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      post<{ next: string[] }>("/api/jobs", { op: "preview", cron: form.cron, timezone: form.timezone })
        .then((r) => setPreview({ next: r.next }))
        .catch((e: Error) => setPreview({ error: e.message }));
    }, 400);
    return () => clearTimeout(t);
  }, [open, form.cron, form.timezone]);

  async function create() {
    setBusy(true);
    try {
      await post("/api/jobs", { op: "create", ...form });
      toast(`Schedule "${form.name}" created`, "ok");
      setOpen(false);
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-4">
        <Button variant="primary" onClick={() => setOpen(true)}>
          + New schedule
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-4" title="New schedule" subtitle="Pick one of the built-in workflows. What it may access is fixed by the workflow and checked against your permissions before every run.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Workflow">
          <select
            className={inputCls}
            value={form.workflow}
            onChange={(e) => {
              const c = state.catalog.find((x) => x.workflow === e.target.value);
              setForm({ ...form, workflow: e.target.value, name: c?.name ?? form.name, cron: c?.defaultCron ?? form.cron });
            }}
          >
            {state.catalog.map((c) => (
              <option key={c.workflow} value={c.workflow}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input className={inputCls} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Schedule" hint="5-field cron (minute hour day month weekday), e.g. 30 8 * * 1-5 = weekdays 08:30; or an ISO date-time like 2026-11-02T09:00:00 for a one-time run">
          <input className={`${inputCls} font-mono`} value={form.cron} maxLength={100} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
        </Field>
        <Field label="Timezone (IANA)" hint="Daylight-saving changes are handled; 08:30 stays 08:30 local time">
          <input className={inputCls} value={form.timezone} maxLength={64} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </Field>
      </div>
      {entry && (
        <p className="mt-3 text-xs text-muted">
          {entry.description} Delivers to: {entry.destination}.
        </p>
      )}
      <div className="mt-2 rounded-lg bg-panel-2 p-2.5 text-xs" aria-live="polite">
        {preview.error ? (
          <span className="text-danger">{preview.error}</span>
        ) : preview.next ? (
          <>
            <span className="font-medium">{describeSchedule(form.cron)}</span> — next runs: {preview.next.map((n) => fmtDateTime(n, form.timezone)).join(" · ") || "none (date is in the past)"}
          </>
        ) : (
          <span className="text-muted">Checking schedule…</span>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={busy} disabled={Boolean(preview.error) || !form.name.trim()} onClick={create}>
          Create schedule
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
