"use client";

import { useEffect, useState } from "react";
import type { SectionProps } from "../Dashboard";
import type { ActivityRow } from "@/server/activity";
import { Badge, Card, Empty, SectionHeader } from "../ui";
import { fmtDateTime } from "../api";

const KINDS: [string, string][] = [
  ["", "All"],
  ["data_access", "Data access"],
  ["agent_run", "Agent runs"],
  ["action_proposed", "Proposed"],
  ["action_approved", "Approvals"],
  ["action_executed", "Executions"],
  ["permission_denied", "Denials"],
  ["permission_change", "Permission changes"],
  ["connection_change", "Connections"],
  ["schedule", "Schedules"],
  ["retrieval", "Retrieval"],
];

export function ActivityView({ state }: SectionProps) {
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fetched only while this page is open; refreshed with each dashboard refresh (state.now changes).
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/activity${kind ? `?kind=${kind}` : ""}`, { cache: "no-store", signal: ctrl.signal })
      .then(async (r) => (r.ok ? setItems((await r.json()) as ActivityRow[]) : setError(`Couldn't load the log (HTTP ${r.status})`)))
      .catch((e: Error) => e.name !== "AbortError" && setError("Couldn't load the log"));
    return () => ctrl.abort();
  }, [kind, state.now]);
  return (
    <div>
      <SectionHeader
        title="Activity Log"
        description="Who accessed what, which agent ran, what was proposed, approved, denied or executed. Message bodies, note contents and secrets are never logged — only summaries and identifiers."
      />
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
        {KINDS.map(([k, label]) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={`rounded-full border px-2.5 py-1 text-xs ${kind === k ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-panel-2"}`}>
            {label}
          </button>
        ))}
      </div>
      <Card>
        {error && !items ? (
          <Empty title={error} />
        ) : !items ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <Empty title="Nothing logged yet" />
        ) : (
          <ol className="divide-y divide-line">
            {items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 text-sm">
                <span className="w-40 shrink-0 font-mono text-xs text-muted">{fmtDateTime(a.ts)}</span>
                <Badge tone={a.outcome === "ok" ? "ok" : a.outcome === "denied" ? "warn" : a.outcome === "failed" ? "danger" : a.outcome === "pending" ? "accent" : "neutral"}>{a.outcome}</Badge>
                <span className="min-w-0 flex-1">
                  {a.summary}
                  <span className="block text-xs text-muted">
                    {a.actor}
                    {a.service_id && ` · ${a.service_id}`} · {a.kind.replace(/_/g, " ")}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
