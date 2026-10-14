"use client";

import type { Impact } from "@/server/impact";
import { Card } from "./ui";

/** What the assistant did for you this week: counts of real events, plus one clearly labelled estimate. */
export function ImpactCard({ impact, onOpen }: { impact: Impact; onOpen: (section: "insights" | "actions") => void }) {
  const tiles: { label: string; value: number; detail?: string; open: "insights" | "actions" }[] = [
    { label: "Conversations revived", value: impact.conversationsRevived, detail: "answered after a nudge", open: "insights" },
    { label: "Nudges approved", value: impact.nudgesApproved, detail: `${impact.stillWaiting} still waiting`, open: "insights" },
    { label: "Replies approved", value: impact.repliesApproved, detail: `of ${impact.repliesDrafted} drafted`, open: "actions" },
    { label: "Trips & bookings tracked", value: impact.bookingsTracked, detail: `${impact.bookingReminders} turned into reminders`, open: "insights" },
    { label: "Paid subscriptions flagged", value: impact.paidSubscriptions, detail: impact.auditRan ? "audited this week" : "from the last audit", open: "insights" },
  ];
  const nothingYet = impact.minutesSaved === 0 && tiles.every((t) => t.value === 0);
  return (
    <Card className="mb-4" title="Impact this week" subtitle={`Last ${impact.days} days · counted from what actually happened; only the time saved is an estimate`}>
      {nothingYet ? (
        <p className="text-sm text-muted">Nothing yet. Check Inbox insights, approve a draft or a nudge, and this card starts counting.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="rounded-lg bg-accent-soft px-4 py-3 sm:min-w-44">
            <p className="text-xs text-muted">Estimated time saved</p>
            <p className="text-3xl font-semibold tabular-nums text-ink">
              {formatMinutes(impact.minutesSaved)}
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            {tiles.map((t) => (
              <li key={t.label}>
                <button onClick={() => onOpen(t.open)} className="h-full w-full rounded-lg border border-line p-2.5 text-left hover:bg-panel-2">
                  <span className="block text-xl font-semibold tabular-nums">{t.value}</span>
                  <span className="block text-xs">{t.label}</span>
                  {t.detail && <span className="block text-[11px] text-muted">{t.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="mt-3 text-[11px] text-muted">
        <summary className="cursor-pointer">How the time saved is estimated</summary>
        <p className="mt-1">{impact.formula}. Drafts you dismissed and anything still waiting for approval count as zero.</p>
      </details>
    </Card>
  );
}

function formatMinutes(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
