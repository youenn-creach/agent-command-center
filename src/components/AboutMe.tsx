"use client";

import { useState } from "react";
import type { DashboardState } from "@/server/state";
import { post } from "./api";
import { Button, Card, Empty, inputCls, useToast } from "./ui";

/** "About me": facts the user writes for agents to use when writing on their behalf. */
export function AboutMeCard({ facts, refresh }: { facts: DashboardState["memory"]; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(body: Record<string, unknown>, ok?: string) {
    setBusy(true);
    try {
      await post("/api/memory", body);
      if (ok) toast(ok, "ok");
      await refresh();
      return true;
    } catch (e) {
      toast((e as Error).message, "danger");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4" title="About me" subtitle="Facts agents use when they write for you (reply drafts, follow-ups). Only you can add them. Tip: in Ctrl+K, type “remember …”.">
      {facts.length === 0 ? (
        <Empty title="Nothing yet">For example: “I sign emails as Sam”, “I prefer short, informal replies”, “I work 9:00–17:30 on weekdays”.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {facts.map((f) => (
            <li key={f.id} className="flex items-start gap-2 rounded-md bg-panel-2 px-2 py-1.5 text-sm">
              {editing?.id === f.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await call({ op: "update", id: f.id, text: editing.text }, "Updated")) setEditing(null);
                  }}
                >
                  <label className="sr-only" htmlFor={`fact-${f.id}`}>
                    Edit fact
                  </label>
                  <input id={`fact-${f.id}`} className={`${inputCls} flex-1`} value={editing.text} maxLength={300} onChange={(e) => setEditing({ id: f.id, text: e.target.value })} />
                  <Button type="submit" busy={busy}>
                    Save
                  </Button>
                  <Button variant="ghost" type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex-1">{f.text}</span>
                  <button className="text-xs text-muted underline hover:text-ink" onClick={() => setEditing({ id: f.id, text: f.text })}>
                    Edit
                  </button>
                  <button className="text-xs text-danger underline" disabled={busy} onClick={() => call({ op: "delete", id: f.id }, "Removed")}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() && (await call({ op: "add", text }, "Saved"))) setText("");
        }}
      >
        <label className="sr-only" htmlFor="new-fact">
          New fact about you
        </label>
        <input id="new-fact" className={`${inputCls} flex-1`} placeholder="Add a fact about you…" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy}>
          Add
        </Button>
      </form>
    </Card>
  );
}
