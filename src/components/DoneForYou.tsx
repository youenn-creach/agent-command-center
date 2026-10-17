"use client";

import { useState } from "react";
import type { DashboardState } from "@/server/state";
import { Badge, Button, Card, useToast } from "./ui";
import { post, relative } from "./api";

type Done = DashboardState["autopilot"]["done"][number];

const KIND: Record<string, string> = { calendar_event: "Calendar", email_draft: "Gmail draft", reminder: "Reminder" };

/** What autopilot did without a click (and reminders the assistant added today), each with Undo. Hidden when empty. */
export function DoneForYouCard({ done, refresh }: { done: Done[]; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!done.length) return null;
  const undo = async (d: Done) => {
    setBusy(d.id);
    try {
      const out = await post<{ summary: string }>("/api/actions", { op: "undo", type: d.type, id: d.id });
      toast(out.summary, "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Done for you" subtitle="What was done without your click (autopilot), and reminders added from your requests today. Undo removes it.">
      <ul className="divide-y divide-line">
        {done.map((d) => (
          <li key={`${d.type}-${d.id}`} className="flex items-center gap-3 py-2 text-sm">
            <Badge tone={d.status === "undone" ? "neutral" : "accent"}>{KIND[d.kind] ?? d.kind}</Badge>
            <span className={d.status === "undone" ? "min-w-0 flex-1 truncate text-muted line-through" : "min-w-0 flex-1 truncate"}>{d.title.replace(/^Calendar: /, "")}</span>
            <span className="shrink-0 text-xs text-muted">{relative(d.at)}</span>
            {d.status === "executed" ? (
              <Button variant="ghost" busy={busy === d.id} onClick={() => undo(d)}>
                Undo
              </Button>
            ) : (
              <span className="shrink-0 text-xs text-muted">{d.status === "undone" ? "undone" : d.status}</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
