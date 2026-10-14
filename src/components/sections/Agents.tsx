"use client";

import type { SectionProps } from "../Dashboard";
import { Badge, Card, Dot, SectionHeader } from "../ui";
import { LEVEL_LABEL, agentLight, fmtDateTime, relative, stepLabel } from "../api";
import { ServiceIcon } from "../icons";

export function AgentsView({ state }: SectionProps) {
  const serviceName = (id: string) => state.services.find((s) => s.id === id)?.name ?? id;
  return (
    <div>
      <SectionHeader
        title="Agents"
        description="One orchestrator and four bounded specialists. The Chief of Staff runs fixed workflows and has no data access of its own; each specialist only does what its permissions allow, within a per-run tool-call and time budget. Agents cannot grant permissions — to themselves or each other."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {state.agents.map((a) => {
          const cells = state.matrix.find((m) => m.agentId === a.id)?.cells.filter((c) => c.effective !== "none") ?? [];
          const tone = a.status === "running" ? "accent" : a.status === "error" ? "danger" : "ok";
          return (
            <Card key={a.id} className={a.id === "chief_of_staff" ? "md:col-span-2" : undefined}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 font-semibold">
                    <Dot tone={tone} /> {a.name}
                  </p>
                  <p className="text-xs text-muted">{a.role}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={tone}>{agentLight(a).label}</Badge>
                  {a.pendingApprovals > 0 && <Badge tone="accent">{a.pendingApprovals} awaiting approval</Badge>}
                </div>
              </div>
              {a.status === "running" && a.current_step && <p className="mt-2 text-xs text-accent">Now: {stepLabel(a.current_step)}…</p>}
              <p className="mt-2 text-sm">{a.description}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted">Last run</dt>
                  <dd>{a.last_run_at ? relative(a.last_run_at) : "never"}</dd>
                </div>
                <div>
                  <dt className="text-muted">Next scheduled run</dt>
                  <dd>{a.nextRun ? fmtDateTime(a.nextRun) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">Owns schedules</dt>
                  <dd>{a.jobs.length ? a.jobs.join(", ") : "—"}</dd>
                </div>
              </dl>
              {a.last_error && <p className="mt-2 rounded-md bg-danger-soft px-2 py-1 text-xs text-danger">Last error: {a.last_error}</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {cells.length === 0 ? (
                  <Badge>No direct data access</Badge>
                ) : (
                  cells.map((c) => (
                    <Badge key={c.serviceId} tone="local" title={c.reason}>
                      <ServiceIcon id={c.serviceId} size={12} />
                      {serviceName(c.serviceId)}: {LEVEL_LABEL[c.effective]}
                    </Badge>
                  ))
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
