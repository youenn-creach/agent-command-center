import { execFile } from "node:child_process";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { getSetting, one, run, setSetting, type Ctx } from "./db";
import { open, seal } from "./connectors/secretBox";
import { safeAgent, validateFeedUrl } from "./news/feeds";
import { appMode, assertRealAccountsAllowed } from "./mode";

/**
 * The assistant reaching you first: a desktop notification on this machine, and optionally a push
 * to your phone through ntfy (https://ntfy.sh or your own server). Off until you turn it on.
 *
 * Privacy: desktop notifications stay on this machine and may show details (a subject line).
 * A push goes through the ntfy server, so it carries only a generic line ("1 item waiting for your
 * approval") unless you opt in to details. Each event notifies once, at most 12 per hour.
 */

export const NOTIFY_KINDS = ["approval", "briefing", "waiting", "booking", "failure", "answer"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export const NOTIFY_LABELS: Record<NotifyKind, string> = {
  approval: "Something waits for your approval",
  briefing: "Morning briefing is ready",
  waiting: "Someone hasn't answered you",
  booking: "A trip or booking was found",
  failure: "A scheduled task failed",
  answer: "The answer to a request is ready",
};

export interface Notice {
  /** Dedupe key: one notification per key, ever (e.g. "approval:act_123"). */
  key: string;
  kind: NotifyKind | "test";
  title: string;
  /** Safe to send anywhere: no names, subjects or content. */
  summary: string;
  /** May contain a subject line: desktop always, push only if the user opted in. */
  detail?: string;
}

const PER_HOUR = 12;
const URL_CONTEXT = "notify.ntfy";

export const NotifySettingsInput = z.object({
  desktop: z.boolean(),
  details: z.boolean(),
  kinds: z.array(z.enum(NOTIFY_KINDS)),
  /** undefined = keep, null = remove, string = new ntfy topic URL. */
  ntfyUrl: z.string().trim().max(300).nullable().optional(),
});

export function notificationSettings(ctx: Ctx) {
  const sealed = getSetting(ctx.db, "notify.ntfy");
  let ntfyHost: string | null = null;
  if (sealed) {
    try {
      ntfyHost = new URL(open(sealed, URL_CONTEXT)).host;
    } catch {
      ntfyHost = null;
    }
  }
  const kinds = JSON.parse(getSetting(ctx.db, "notify.kinds") ?? JSON.stringify(NOTIFY_KINDS)) as NotifyKind[];
  return { desktop: getSetting(ctx.db, "notify.desktop") === "1", details: getSetting(ctx.db, "notify.details") === "1", kinds, ntfyHost };
}

export function setNotificationSettings(ctx: Ctx, raw: z.input<typeof NotifySettingsInput>) {
  const input = NotifySettingsInput.parse(raw);
  if (input.ntfyUrl) {
    assertRealAccountsAllowed("Phone notifications");
    const url = validateFeedUrl(input.ntfyUrl);
    if (url.pathname.split("/").filter(Boolean).length !== 1) throw new NotifyError("Use the topic URL, e.g. https://ntfy.sh/your-private-topic");
    setSetting(ctx.db, "notify.ntfy", seal(url.toString(), URL_CONTEXT));
  } else if (input.ntfyUrl === null) {
    run(ctx.db, "DELETE FROM settings WHERE key = 'notify.ntfy'");
  }
  setSetting(ctx.db, "notify.desktop", input.desktop ? "1" : "0");
  setSetting(ctx.db, "notify.details", input.details ? "1" : "0");
  setSetting(ctx.db, "notify.kinds", JSON.stringify(input.kinds));
}

export class NotifyError extends Error {}

export interface NotifyDeps {
  desktop(title: string, body: string): Promise<void>;
  push(url: string, title: string, body: string): Promise<number>;
}

export const defaultNotifyDeps: NotifyDeps = {
  desktop: (title, body) =>
    new Promise((resolve) => {
      // "--" ends option parsing, so a subject starting with "-" can't be read as a flag; and
      // notification bodies render a little markup, so text is escaped (no links or images).
      const plain = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 500);
      execFile("notify-send", ["--app-name=Agent Command Center", "--", plain(title), plain(body)], { timeout: 5000 }, () => resolve());
    }),
  async push(url, title, body) {
    const target = `${url}?${new URLSearchParams({ title, tags: "robot" })}`;
    const res = await undiciFetch(target, { method: "POST", body, dispatcher: safeAgent, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.status;
  },
};

let currentDeps: NotifyDeps = defaultNotifyDeps;
/** Tests swap the channels so nothing ever pops up on the developer's screen or phone. */
export function setNotifyDeps(deps: NotifyDeps) {
  currentDeps = deps;
}

/** Sends a notice through every channel that is on. Never throws: notifications are best-effort. */
export async function notify(ctx: Ctx, n: Notice, deps: NotifyDeps = currentDeps): Promise<{ desktop: boolean; push: boolean } | null> {
  const s = notificationSettings(ctx);
  const sealed = getSetting(ctx.db, "notify.ntfy");
  const pushOn = Boolean(sealed) && appMode() !== "demo";
  if (!s.desktop && !pushOn) return null;
  if (n.kind !== "test") {
    if (!s.kinds.includes(n.kind)) return null;
    const recent = one<{ c: number }>(ctx.db, "SELECT COUNT(*) c FROM notifications_sent WHERE sent_at > ?", new Date(ctx.now().getTime() - 3_600_000).toISOString())!.c;
    if (recent >= PER_HOUR) return null;
    const fresh = run(ctx.db, "INSERT OR IGNORE INTO notifications_sent (key, kind, title, sent_at) VALUES (?, ?, ?, ?)", n.key, n.kind, n.title.slice(0, 200), ctx.now().toISOString());
    if (!fresh.changes) return null; // already notified about this
  }
  const sent = { desktop: false, push: false };
  try {
    if (s.desktop) {
      await deps.desktop(n.title, n.detail ?? n.summary);
      sent.desktop = true;
    }
    if (pushOn) {
      const url = open(sealed!, URL_CONTEXT);
      validateFeedUrl(url);
      const status = await deps.push(url, n.title, s.details && n.detail ? n.detail : n.summary);
      sent.push = status >= 200 && status < 300;
    }
  } catch {
    // best-effort: a notification must never break the work that triggered it
  }
  return sent;
}

/** Fire-and-forget wrapper for call sites in synchronous code. */
export function notifyLater(ctx: Ctx, n: Notice) {
  void notify(ctx, n).catch(() => {});
}

/**
 * One notice for whatever is new in a scan (e.g. three unanswered threads → one notification),
 * remembering each item so it is never announced twice.
 */
export function notifyNewItems(ctx: Ctx, kind: NotifyKind, items: { key: string; detail: string }[], title: string, summary: (n: number) => string) {
  const s = notificationSettings(ctx);
  if (!s.desktop && !getSetting(ctx.db, "notify.ntfy")) return;
  const fresh = items.filter((i) => !one(ctx.db, "SELECT 1 FROM notifications_sent WHERE key = ?", `${kind}:${i.key}`));
  if (!fresh.length) return;
  for (const i of fresh) run(ctx.db, "INSERT OR IGNORE INTO notifications_sent (key, kind, title, sent_at) VALUES (?, ?, ?, ?)", `${kind}:${i.key}`, kind, "(item)", "1970-01-01T00:00:00.000Z");
  notifyLater(ctx, { key: `${kind}:batch:${fresh[0].key}:${fresh.length}`, kind, title, summary: summary(fresh.length), detail: fresh.map((i) => i.detail).join("\n").slice(0, 500) });
}
