"use client";

import { useState } from "react";
import type { SectionProps, Go } from "../Dashboard";
import { Badge, Button, Card, Empty, Field, inputCls, SectionHeader, Technical, useToast } from "../ui";
import { LEVEL_LABEL, LEVELS, fmtDateTime, post, relative } from "../api";

type Action = SectionProps["state"]["actions"][number];

const KIND_LABEL: Record<string, string> = { email_reply: "Email reply", email_draft: "Gmail draft", calendar_event: "Calendar event", reminder: "Reminder", webhook: "Webhook call" };
const EFFECT: Record<string, string> = {
  email_reply: "Would send this email. In this build: written to the local simulated outbox only — nothing is sent.",
  calendar_event: "Would create this calendar event. In this build: recorded in the local simulated outbox only.",
  reminder: "Adds this reminder to your dashboard.",
  email_draft: "Creates this draft in your real Gmail (Drafts folder, in the same thread). It is NOT sent: you review and send it from Gmail yourself.",
  webhook: "Sends exactly this JSON to your webhook (Zapier, Make, n8n…). This is a REAL external effect: whatever that automation does will happen.",
};

export function ActionQueueView({ state, refresh, go }: SectionProps & { go: Go }) {
  const open = state.actions.filter((a) => a.status === "proposed" || a.status === "approved");
  const done = state.actions.filter((a) => !["proposed", "approved"].includes(a.status));
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const effective = (agentId: string, serviceId: string) => state.matrix.find((m) => m.agentId === agentId)?.cells.find((c) => c.serviceId === serviceId)?.effective ?? "none";

  return (
    <div>
      <SectionHeader
        title="Action Queue"
        description="Agents can only propose. Each external effect needs your approval of the exact content and destination; editing clears an approval, and execution re-checks permissions."
      />
      <div className="space-y-3">
        {open.length === 0 ? (
          <Empty title="Nothing waiting for you">Run the briefing or the follow-up sweep to have agents draft replies and reminders.</Empty>
        ) : (
          open.map((a) => <ActionCard key={a.id} action={a} agent={agentName(a.agent_id)} effective={effective(a.agent_id, a.service_id)} refresh={refresh} go={go} />)
        )}
      </div>
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card title="History" subtitle="Executed, dismissed, cancelled and failed actions">
          {done.length === 0 ? (
            <Empty title="No history yet" />
          ) : (
            <ul className="divide-y divide-line">
              {done.slice(0, 15).map((a) => (
                <li key={a.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} />
                    <span className="font-medium">{a.title}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {a.approved_by ? `Approved by ${a.approved_by} ${relative(a.approved_at)} · ` : ""}
                    {a.result ?? `updated ${relative(a.updated_at)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Simulated outbox" subtitle="Where approved external actions land in this build. Nothing here was really sent.">
          {state.outbox.length === 0 ? (
            <Empty title="Empty outbox" />
          ) : (
            <ul className="space-y-2 text-sm">
              {(state.outbox as { id: string; effect: string; created_at: string }[]).map((o) => (
                <li key={o.id}>
                  <p>{o.effect}</p>
                  <p className="text-xs text-muted">{fmtDateTime(o.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "executed" ? "ok" : status === "failed" ? "danger" : status === "approved" ? "accent" : status === "proposed" ? "warn" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

function ActionCard({ action, agent, effective, refresh, go }: { action: Action; agent: string; effective: string; refresh: () => Promise<void>; go: Go }) {
  const toast = useToast();
  const [mode, setMode] = useState<"view" | "edit" | "review">("view");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(action.payload);
  const canApprove = LEVELS.indexOf(effective as (typeof LEVELS)[number]) >= LEVELS.indexOf("write_with_approval");

  async function call(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      await post("/api/actions", { id: action.id, ...body });
      toast(ok, "ok");
      setMode("view");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={action.status === "approved" ? "border-accent" : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={action.status} />
            <Badge tone="local">{KIND_LABEL[action.kind]}</Badge>
            {action.is_demo ? <Badge tone="warn">demo</Badge> : <Badge tone="danger">real effect</Badge>}
          </div>
          <p className="mt-1.5 font-medium">{action.title}</p>
          <p className="text-xs text-muted">
            Proposed by {agent} · {relative(action.created_at)} · destination <code>{action.destination}</code>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {action.status === "proposed" && (
            <>
              <Button onClick={() => setMode(mode === "edit" ? "view" : "edit")}>Edit</Button>
              <Button variant="primary" onClick={() => setMode("review")}>
                Review &amp; approve
              </Button>
              <Button variant="ghost" busy={busy} onClick={() => call({ op: "dismiss" }, "Dismissed")}>
                Dismiss
              </Button>
            </>
          )}
          {action.status === "approved" && (
            <>
              <Button variant="primary" busy={busy} onClick={() => call({ op: "execute" }, "Executed (simulated)")}>
                Execute (simulated)
              </Button>
              <Button onClick={() => setMode(mode === "edit" ? "view" : "edit")}>Edit</Button>
              <Button variant="danger" busy={busy} onClick={() => call({ op: "cancel" }, "Cancelled — nothing was executed")}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {mode !== "edit" && <PayloadView kind={action.kind} payload={action.payload} />}

      {mode === "edit" && (
        <div className="mt-3 space-y-2">
          {action.kind === "webhook" ? (
            Object.entries((draft.fields ?? {}) as Record<string, string>).map(([k, v]) => (
              <Field key={k} label={k}>
                <textarea className={inputCls} rows={3} value={v} onChange={(e) => setDraft({ ...draft, fields: { ...(draft.fields as Record<string, string>), [k]: e.target.value } })} />
              </Field>
            ))
          ) : Object.entries(draft).filter(([k]) => k !== "threadId" && k !== "inReplyTo").map(([k, v]) => (
            <Field key={k} label={k}>
              {k === "body" || k === "text" ? (
                <textarea className={inputCls} rows={5} value={String(v ?? "")} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              ) : (
                <input className={inputCls} value={String(v ?? "")} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              )}
            </Field>
          ))}
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => call({ op: "edit", payload: draft }, action.status === "approved" ? "Saved — approval cleared, please review again" : "Saved")}>
              Save changes
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "review" && (
        <div className="mt-3 rounded-lg border border-accent bg-accent-soft p-3 text-sm" role="region" aria-label="Approval review">
          <p className="font-medium">You are approving exactly this:</p>
          <ul className="mt-1 list-inside list-disc text-xs">
            <li>
              Destination: <code>{action.destination}</code>
            </li>
            <li>Effect: {EFFECT[action.kind]}</li>
            <Technical>
              <li>
                Fingerprint: <code>{action.payload_hash.slice(0, 16)}…</code> — the approval is bound to this content; any change invalidates it.
              </li>
            </Technical>
          </ul>
          {!canApprove ? (
            <div className="mt-2 rounded-md bg-warn-soft p-2 text-xs text-warn">
              The server will refuse this approval: {agent} currently has <strong>{LEVEL_LABEL[effective]}</strong> on this service, and approving needs{" "}
              <strong>Write with approval</strong> at both the service and agent level.{" "}
              <button className="underline" onClick={() => go("permissions")}>
                Open permissions
              </button>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => call({ op: "approve", expectedHash: action.payload_hash }, "Approved. Execute it when ready, or cancel.")}>
              Approve this exact action
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PayloadView({ kind, payload }: { kind: string; payload: Record<string, unknown> }) {
  if (kind === "webhook") {
    const fields = (payload.fields ?? {}) as Record<string, string>;
    return (
      <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3 text-sm">
        <p className="mb-1 text-xs text-muted">JSON fields that will be sent:</p>
        {Object.entries(fields).map(([k, v]) => (
          <p key={k} className="text-xs">
            <code className="text-muted">{k}</code>: <span className="whitespace-pre-wrap">{v}</span>
          </p>
        ))}
      </div>
    );
  }
  if (kind === "email_reply" || kind === "email_draft") {
    return (
      <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3 text-sm">
        <p className="text-xs text-muted">
          To: <span className="text-ink">{String(payload.to)}</span>
        </p>
        <p className="text-xs text-muted">
          Subject: <span className="text-ink">{String(payload.subject)}</span>
        </p>
        <p className="mt-2 whitespace-pre-wrap">{String(payload.body)}</p>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3 text-sm">
      {Object.entries(payload).map(([k, v]) => (
        <p key={k} className="text-xs">
          <span className="text-muted">{k}:</span> {String(v)}
        </p>
      ))}
    </div>
  );
}
