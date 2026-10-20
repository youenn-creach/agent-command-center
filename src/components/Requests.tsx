"use client";

import { useState } from "react";
import type { DashboardState } from "@/server/state";
import type { Go } from "./Dashboard";
import { relative } from "./api";
import { Badge, Button, Card, Empty, Spinner, type Tone } from "./ui";
import { CancelRequest } from "./CommandBar";

const TONE: Record<string, Tone> = { waiting: "accent", working: "accent", done: "ok", failed: "danger", cancelled: "neutral", answered: "neutral", declined: "warn", unsupported: "warn" };

/** Your Ctrl+K requests, where each one is, and the answer it delivered (open one to read it). */
export function RequestsCard({ requests, go, refresh }: { requests: DashboardState["requests"]; go: Go; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Your requests" subtitle="What you asked with Ctrl+K, where each request is now, and its answer.">
      {requests.length === 0 ? (
        <Empty title="No requests yet">Press Ctrl+K and ask in your own words, e.g. “anything in my email this week that needs me?”.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {requests.slice(0, 8).map((r) => {
            const expanded = open === r.id;
            return (
              <li key={r.id} className="rounded-md bg-panel-2">
                <button
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent-soft"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : r.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className={expanded ? "block" : "block truncate"}>{r.text}</span>
                    <span className="block text-[11px] text-muted">{relative(r.created_at)}</span>
                  </span>
                  <Badge tone={TONE[r.state] ?? "neutral"}>
                    {r.state === "working" && <Spinner />}
                    {r.status}
                  </Badge>
                </button>
                {expanded && (
                  <div className="border-t border-line px-2 py-2 text-sm">
                    {r.state === "working" ? (
                      <>
                        <p className="text-muted">Still working on it: {r.status}</p>
                        <CancelRequest id={r.id} refresh={refresh} />
                      </>
                    ) : (
                      <>
                        <p className="whitespace-pre-line">{r.answer?.reply ?? r.reply}</p>
                        {r.answer?.items && r.answer.items.length > 0 && (
                          <ul className="mt-2 space-y-1.5">
                            {r.answer.items.map((it, i) => (
                              <li key={i} className="rounded-md bg-panel px-2 py-1.5">
                                {it.href?.startsWith("https://") ? (
                                  <a className="font-medium text-accent underline" href={it.href} target="_blank" rel="noopener noreferrer">
                                    {it.title}
                                  </a>
                                ) : (
                                  <p className="font-medium">{it.title}</p>
                                )}
                                {it.detail && <p className="whitespace-pre-line text-xs text-muted">{it.detail}</p>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                    {r.section && (
                      <div className="mt-2 flex justify-end">
                        <Button onClick={() => go(r.section as Parameters<Go>[0])}>Open</Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
