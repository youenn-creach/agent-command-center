"use client";

import { useState } from "react";
import type { DashboardState } from "@/server/state";
import { Button, Card, cx, Empty, useToast } from "./ui";
import { fmtDateTime, post, relative } from "./api";

type Reminder = DashboardState["today"]["reminders"][number];

/** Reminders created by approved reminder actions. Ticking one off is local and instant. */
export function RemindersCard({ reminders, refresh, onEmpty }: { reminders: Reminder[]; refresh: () => Promise<void>; onEmpty: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const open = reminders.filter((r) => !r.done_at);
  const done = reminders.filter((r) => r.done_at).slice(0, 3);

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      await post("/api/reminders", { id, ...body });
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={`Reminders${open.length ? ` (${open.length})` : ""}`} subtitle="Yours (“remind me…” in the prompt bar) and the ones you approved from the agents">
      {reminders.length === 0 ? (
        <Empty title="No reminders">
          Ask “remind me to … tomorrow at 9” in the prompt bar, or{" "}
          <button className="underline" onClick={onEmpty}>
            approve one an agent proposed
          </button>
          .
        </Empty>
      ) : (
        <ul className="space-y-1.5">
          {[...open, ...done].map((r) => (
            <li key={r.id} className="group flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                aria-label={r.done_at ? `Reopen: ${r.text}` : `Mark done: ${r.text}`}
                checked={Boolean(r.done_at)}
                disabled={busy === r.id}
                onChange={(e) => void act(r.id, { op: "done", done: e.target.checked })}
              />
              <span className={cx("min-w-0 flex-1", r.done_at && "text-muted line-through")}>
                {r.text}
                <span className="block text-[11px] text-muted no-underline">{r.due_at ? `due ${fmtDateTime(r.due_at)}` : `added ${relative(r.created_at)}`}</span>
              </span>
              <Button variant="ghost" className="opacity-60 group-hover:opacity-100" aria-label={`Delete reminder: ${r.text}`} busy={busy === r.id} onClick={() => void act(r.id, { op: "delete" })}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
