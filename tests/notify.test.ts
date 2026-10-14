import { afterEach, describe, expect, it, vi } from "vitest";
import { getSetting } from "@/server/db";
import { reloadConfig } from "@/server/config";
import { notificationSettings, notify, notifyNewItems, setNotificationSettings, type NotifyDeps } from "@/server/notify";
import { ModeError } from "@/server/mode";
import { seededCtx } from "./helpers";

function fakeDeps() {
  const desktop: string[][] = [];
  const push: string[][] = [];
  const deps: NotifyDeps = {
    async desktop(title, body) {
      desktop.push([title, body]);
    },
    async push(url, title, body) {
      push.push([url, title, body]);
      return 200;
    },
  };
  return { deps, desktop, push };
}
const notice = (key: string) => ({ key, kind: "approval" as const, title: "Waiting for your approval", summary: "An agent prepared something.", detail: "Gmail draft: reply to Ana — Dinner Friday?" });

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
});

describe("desktop notification arguments", () => {
  it("ends option parsing and escapes markup, so a subject can't act as a flag or a link", async () => {
    const calls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: (_cmd: string, args: string[], _o: unknown, cb: () => void) => (calls.push(args), cb()) }));
    const { notify: realNotify, setNotificationSettings: set } = await import("@/server/notify");
    const { setNotifyDeps } = await import("@/server/notify");
    setNotifyDeps((await import("@/server/notify")).defaultNotifyDeps);
    const ctx = seededCtx();
    set(ctx, { desktop: true, details: false, kinds: ["approval"] });
    await realNotify(ctx, { key: "x1", kind: "approval", title: "--expire-time=1", summary: "s", detail: '--icon=/etc/passwd <a href="https://evil.example">click</a> & more' });
    vi.doUnmock("node:child_process");
    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args.indexOf("--")).toBe(1);
    expect(args.slice(2)).toEqual(["--expire-time=1", "--icon=/etc/passwd &lt;a href=\"https://evil.example\"&gt;click&lt;/a&gt; &amp; more"]);
  });
});

describe("notifications", () => {
  it("are off by default", async () => {
    const ctx = seededCtx();
    const f = fakeDeps();
    expect(await notify(ctx, notice("a1"), f.deps)).toBeNull();
    expect(f.desktop).toEqual([]);
  });

  it("desktop shows details; each event notifies once", async () => {
    const ctx = seededCtx();
    setNotificationSettings(ctx, { desktop: true, details: false, kinds: ["approval"] });
    const f = fakeDeps();
    expect(await notify(ctx, notice("a1"), f.deps)).toEqual({ desktop: true, push: false });
    expect(await notify(ctx, notice("a1"), f.deps)).toBeNull();
    expect(f.desktop).toEqual([["Waiting for your approval", "Gmail draft: reply to Ana — Dinner Friday?"]]);
  });

  it("phone pushes stay generic unless details are opted in; the topic URL is stored encrypted", async () => {
    const ctx = seededCtx();
    setNotificationSettings(ctx, { desktop: false, details: false, kinds: ["approval"], ntfyUrl: "https://ntfy.sh/acc-secret-topic-123" });
    expect(getSetting(ctx.db, "notify.ntfy")).not.toContain("acc-secret-topic-123");
    expect(notificationSettings(ctx).ntfyHost).toBe("ntfy.sh");
    const f = fakeDeps();
    await notify(ctx, notice("a1"), f.deps);
    expect(f.push).toEqual([["https://ntfy.sh/acc-secret-topic-123", "Waiting for your approval", "An agent prepared something."]]);
    setNotificationSettings(ctx, { desktop: false, details: true, kinds: ["approval"] });
    await notify(ctx, notice("a2"), f.deps);
    expect(f.push[1][2]).toBe("Gmail draft: reply to Ana — Dinner Friday?");
  });

  it("refuses unsafe or non-topic ntfy URLs", () => {
    const ctx = seededCtx();
    const base = { desktop: false, details: false, kinds: [] as never[] };
    expect(() => setNotificationSettings(ctx, { ...base, ntfyUrl: "http://ntfy.sh/topic" })).toThrow();
    expect(() => setNotificationSettings(ctx, { ...base, ntfyUrl: "https://127.0.0.1/topic" })).toThrow();
    expect(() => setNotificationSettings(ctx, { ...base, ntfyUrl: "https://ntfy.sh/" })).toThrow(/topic URL/);
  });

  it("respects the chosen events and caps at 12 an hour", async () => {
    const ctx = seededCtx();
    setNotificationSettings(ctx, { desktop: true, details: false, kinds: ["briefing"] });
    const f = fakeDeps();
    expect(await notify(ctx, notice("a1"), f.deps)).toBeNull(); // approvals not chosen
    for (let i = 0; i < 15; i++) await notify(ctx, { key: `b${i}`, kind: "briefing", title: "Briefing", summary: "Ready" }, f.deps);
    expect(f.desktop).toHaveLength(12);
  });

  it("groups new scan results into one notice and never repeats an item", async () => {
    const ctx = seededCtx();
    setNotificationSettings(ctx, { desktop: true, details: false, kinds: ["waiting"] });
    notifyNewItems(ctx, "waiting", [{ key: "t1", detail: "Shelves" }, { key: "t2", detail: "Trip" }], "Still no answer", (n) => `${n} waiting`);
    notifyNewItems(ctx, "waiting", [{ key: "t1", detail: "Shelves" }, { key: "t2", detail: "Trip" }], "Still no answer", (n) => `${n} waiting`);
    await new Promise((r) => setTimeout(r, 20));
    const sent = ctx.db.prepare("SELECT key FROM notifications_sent WHERE key LIKE 'waiting:batch:%'").all();
    expect(sent).toHaveLength(1);
  });

  it("can't push to a phone from the demo", () => {
    vi.stubEnv("ACC_MODE", "demo");
    reloadConfig();
    const ctx = seededCtx();
    expect(() => setNotificationSettings(ctx, { desktop: false, details: false, kinds: [], ntfyUrl: "https://ntfy.sh/acc-x" })).toThrow(ModeError);
  });
});
