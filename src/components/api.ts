"use client";

export async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-acc-request": "1" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function fmtDateTime(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
}

export function relative(iso: string | null | undefined) {
  if (!iso) return "never";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff > 0 ? `in ${n} ${name}${n > 1 ? "s" : ""}` : `${n} ${name}${n > 1 ? "s" : ""} ago`;
    }
  }
  return diff > 0 ? "in under a minute" : "just now";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human-readable text for the cron shapes this app creates; falls back to the raw pattern. */
export function describeSchedule(cron: string) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(cron)) return `Once, ${new Date(cron).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  const m = cron.trim().split(/\s+/);
  if (m.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = m;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*") return cron;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "*") return `Every day at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (/^\d$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${time}`;
  return cron;
}

export const LEVELS = ["none", "read", "prepare", "write_with_approval", "auto_act"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<string, string> = {
  none: "None",
  read: "Read",
  prepare: "Prepare",
  write_with_approval: "Write with approval",
  auto_act: "Auto-act",
};

/** Plain-language label for what a running agent is doing (its current tool or workflow). */
const STEP_LABELS: Record<string, string> = {
  "workflow.daily_briefing": "Preparing the morning briefing",
  "workflow.weekly_review": "Writing the weekly review",
  "calendar.list_events": "Checking the calendar",
  "gcal.sync": "Syncing Google Calendar",
  "gcal.list_events": "Checking Google Calendar",
  "inbox.list_messages": "Reading mail headers",
  "gmail.sync": "Syncing Gmail headers",
  "gmail.list_messages": "Reading Gmail headers",
  "gmail.read_message": "Reading one email to draft a reply",
  "news.refresh": "Fetching the news",
  "news.list_items": "Reading the news",
  "weather.forecast": "Getting the forecast",
  "knowledge.search": "Searching your notes",
  "actions.propose": "Preparing something for your approval",
};
export function stepLabel(step: string | null | undefined): string | null {
  return step ? (STEP_LABELS[step] ?? step) : null;
}

/** Sidebar/Agents light: working (pulsing), standby, or error. */
export function agentLight(a: { status: string }): { state: "active" | "off" | "revoked"; label: string } {
  if (a.status === "running") return { state: "active", label: "Working" };
  if (a.status === "error") return { state: "revoked", label: "Error" };
  return { state: "off", label: "Standby" };
}
