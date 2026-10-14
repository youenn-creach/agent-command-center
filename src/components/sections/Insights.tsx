"use client";

import { useState } from "react";
import type { SectionProps } from "../Dashboard";
import { post, relative } from "../api";
import { Badge, Button, Card, Empty, SectionHeader, useToast, type Tone } from "../ui";

const KIND: Record<string, { label: string; tone: Tone }> = {
  flight: { label: "Flight", tone: "accent" },
  train: { label: "Train", tone: "accent" },
  car: { label: "Car", tone: "accent" },
  stay: { label: "Stay", tone: "ok" },
  table: { label: "Table", tone: "warn" },
  event: { label: "Tickets", tone: "voyage" },
  booking: { label: "Booking", tone: "neutral" },
};

const daysAgo = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
const displayName = (v: string) => v.replace(/\s*<[^>]*>/, "").replace(/"/g, "").trim() || v;

export function InsightsView({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { waiting, bookings, subscriptions, scannedAt } = state.insights;
  const gmailOn = state.services.some((s) => s.id === "gmail" && s.connection_state === "connected");

  async function act<T extends { message?: string }>(key: string, body: Record<string, unknown>, ok: (r: T) => string) {
    setBusy(key);
    try {
      const r = await post<T>("/api/insights", body);
      toast(ok(r), "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  const scanned = (at: string | null) => (at ? `Checked ${relative(at)}` : "Not checked yet");

  return (
    <div>
      <SectionHeader
        title="Inbox insights"
        description="What your mail says you might be forgetting. Read from Gmail headers only (sender, subject, date), never message bodies, and nothing is changed in Gmail: follow-ups are drafts you approve, reminders stay in this dashboard."
      />
      {!gmailOn && waiting.length + bookings.length + subscriptions.length === 0 && (
        <p className="mb-4 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-muted">Connect Gmail (read-only) in Connections &amp; Permissions to fill this page.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          className="min-w-0"
          title="Still no answer"
          subtitle={`Threads where you wrote last, 3+ days ago. ${scanned(scannedAt.waiting)}.`}
          actions={
            gmailOn && (
              <Button busy={busy === "refresh"} disabled={busy !== null} onClick={() => act<{ message: string }>("refresh", { op: "refresh" }, (r) => r.message)}>
                Check now
              </Button>
            )
          }
        >
          {waiting.length === 0 ? (
            <Empty title="Nobody owes you an answer" />
          ) : (
            <ul className="space-y-1.5">
              {waiting.map((w) => (
                <li key={w.thread_id} className="flex items-start gap-2 rounded-md bg-panel-2 px-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{w.subject}</span>
                    <span className="block text-xs text-muted">
                      to {displayName(w.recipient)} · {daysAgo(w.sent_at)} days ago
                    </span>
                  </span>
                  <Button busy={busy === `nudge-${w.thread_id}`} disabled={busy !== null} onClick={() => act("nudge-" + w.thread_id, { op: "nudge", threadId: w.thread_id }, () => "Follow-up drafted: review it in the Action Queue")}>
                    Draft a nudge
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="min-w-0" title="Trips & bookings" subtitle={`Confirmations from the last 6 months. ${scanned(scannedAt.bookings)}.`}>
          {bookings.length === 0 ? (
            <Empty title="No bookings found" />
          ) : (
            <ul className="space-y-1.5">
              {bookings.map((b) => (
                <li key={b.id} className="flex items-start gap-2 rounded-md bg-panel-2 px-2 py-1.5 text-sm">
                  <Badge tone={KIND[b.kind]?.tone ?? "neutral"}>{KIND[b.kind]?.label ?? "Booking"}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{b.subject}</span>
                    <span className="block text-xs text-muted">
                      {displayName(b.sender)} · {relative(b.received_at)}
                    </span>
                  </span>
                  <Button busy={busy === `remind-${b.id}`} disabled={busy !== null} onClick={() => act("remind-" + b.id, { op: "remind", bookingId: b.id }, () => "Added to your reminders (Today)")}>
                    Remind me
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Subscriptions"
        subtitle={`Senders of mail you can unsubscribe from (last 4 months). Nothing is unsubscribed for you. ${scanned(scannedAt.subscriptions)}.`}
        actions={
          gmailOn && (
            <Button busy={busy === "audit"} disabled={busy !== null} onClick={() => act<{ message: string }>("audit", { op: "audit-subscriptions" }, (r) => r.message)}>
              {scannedAt.subscriptions ? "Audit again" : "Run the audit"}
            </Button>
          )
        }
      >
        {subscriptions.length === 0 ? (
          <Empty title="No audit yet">The audit reads up to 100 recent message headers; it takes about half a minute.</Empty>
        ) : (
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Subscriptions (scrolls sideways on small screens)">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 font-medium">Sender</th>
                  <th className="font-medium">Emails</th>
                  <th className="font-medium">Last</th>
                  <th className="font-medium">
                    <span className="sr-only">Notes</span>
                  </th>
                  <th className="font-medium">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={s.sender} className="border-t border-line">
                    <td className="py-1.5 pr-2">
                      <span className="block font-medium">{s.name}</span>
                      <span className="block text-xs text-muted">{s.sender}</span>
                    </td>
                    <td className="pr-2">{s.messages}</td>
                    <td className="pr-2 text-xs text-muted">{relative(s.last_seen)}</td>
                    <td className="pr-2">{s.looks_paid ? <Badge tone="warn" title="A subject mentioned a receipt, renewal, invoice or payment">looks paid</Badge> : null}</td>
                    <td className="text-right">
                      {!s.is_demo && (
                        <a className="text-xs text-accent underline" href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`from:${s.sender}`)}`} target="_blank" rel="noopener noreferrer">
                          Open in Gmail
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
