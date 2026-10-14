import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { all, run } from "@/server/db";
import { open, seal, keyPath } from "@/server/connectors/secretBox";
import { disconnectGoogle, handleCallback, pkceChallenge, SCOPES, startAuth, syncCalendar, syncGmail, type Fetcher } from "@/server/connectors/google";
import { callTool } from "@/server/tools/registry";
import { RunBudget } from "@/server/tools/budget";
import { PolicyError } from "@/server/policy/engine";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { seededCtx } from "./helpers";

type Call = { url: string; init?: RequestInit };

/** A fake Google: token endpoint, revoke endpoint, Gmail and Calendar APIs. */
function fakeGoogle(opts: { scope?: string; tokenError?: string; refreshError?: string } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.href.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "refresh_token") {
        return opts.refreshError ? json({ error: opts.refreshError }, 400) : json({ access_token: "access-2", expires_in: 3600 });
      }
      if (opts.tokenError) return json({ error: opts.tokenError }, 400);
      return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: opts.scope ?? SCOPES.gmail.join(" ") });
    }
    if (u.href.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
    if (u.pathname.endsWith("/users/me/messages")) return json({ messages: [{ id: "m1" }, { id: "m2" }, { id: "../evil" }] });
    if (u.pathname.endsWith("/users/me/messages/m1"))
      return json({ id: "m1", labelIds: ["INBOX", "UNREAD"], internalDate: "1760259600000", payload: { headers: [{ name: "From", value: "Ana <ana@example.com>" }, { name: "Subject", value: "Dinner Friday?" }] } });
    if (u.pathname.endsWith("/users/me/messages/m2"))
      return json({ id: "m2", labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], internalDate: "1760259600000", payload: { headers: [{ name: "From", value: "deals@shop.example" }, { name: "Subject", value: "50% off" }] } });
    if (u.pathname.endsWith("/calendars/primary/events"))
      return json({ summary: "me@example.com", items: [{ id: "e1", summary: "Team lunch", start: { dateTime: "2026-10-12T12:00:00+02:00" }, end: { dateTime: "2026-10-12T13:00:00+02:00" } }, { id: "e2", status: "cancelled", summary: "Old", start: { date: "2026-10-12" } }] });
    return json({ error: "not found" }, 404);
  };
  return { fetcher, calls };
}

function connect(ctx: ReturnType<typeof seededCtx>, service: "gmail" | "google-calendar", g = fakeGoogle({ scope: SCOPES[service].join(" ") })) {
  const url = new URL(startAuth(ctx, service));
  return handleCallback(ctx, { code: "auth-code", state: url.searchParams.get("state") }, g.fetcher).then(() => g);
}

describe("token encryption", () => {
  it("round-trips, binds the service, and detects tampering", () => {
    const sealed = seal("secret-token", "gmail");
    expect(sealed).not.toContain("secret-token");
    expect(open(sealed, "gmail")).toBe("secret-token");
    expect(() => open(sealed, "google-calendar")).toThrow();
    const raw = Buffer.from(sealed.split(":")[1], "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => open(`v1:${raw.toString("base64")}`, "gmail")).toThrow();
  });

  it("keeps the key file private (0600)", () => {
    seal("x", "gmail");
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
  });
});

describe("OAuth flow", () => {
  it("builds a PKCE (S256), read-only, offline consent URL", () => {
    const ctx = seededCtx();
    const url = new URL(startAuth(ctx, "gmail"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = all<{ code_verifier: string }>(ctx.db, "SELECT code_verifier FROM oauth_pending WHERE state = ?", url.searchParams.get("state")!)[0];
    expect(pkceChallenge(pending.code_verifier)).toBe(url.searchParams.get("code_challenge"));
  });

  it("rejects unknown, reused and expired states", async () => {
    const ctx = seededCtx();
    const g = fakeGoogle();
    await expect(handleCallback(ctx, { code: "c", state: "forged" }, g.fetcher)).rejects.toMatchObject({ code: "BAD_STATE" });
    const state = new URL(startAuth(ctx, "gmail")).searchParams.get("state");
    await handleCallback(ctx, { code: "c", state }, g.fetcher);
    await expect(handleCallback(ctx, { code: "c", state }, g.fetcher)).rejects.toMatchObject({ code: "BAD_STATE" });
    const old = new URL(startAuth(ctx, "gmail")).searchParams.get("state");
    ctx.setNow(new Date(ctx.now().getTime() + 11 * 60_000));
    await expect(handleCallback(ctx, { code: "c", state: old }, g.fetcher)).rejects.toMatchObject({ code: "BAD_STATE" });
  });

  it("reports a refused consent without storing anything", async () => {
    const ctx = seededCtx();
    const state = new URL(startAuth(ctx, "gmail")).searchParams.get("state");
    await expect(handleCallback(ctx, { error: "access_denied", state }, fakeGoogle().fetcher)).rejects.toMatchObject({ code: "DENIED" });
    expect(all(ctx.db, "SELECT * FROM oauth_connections")).toHaveLength(0);
  });

  it("refuses (and revokes) a grant missing the scope or broader than requested", async () => {
    for (const scope of ["", "https://www.googleapis.com/auth/gmail.metadata https://mail.google.com/"]) {
      const ctx = seededCtx();
      const g = fakeGoogle({ scope });
      const state = new URL(startAuth(ctx, "gmail")).searchParams.get("state");
      await expect(handleCallback(ctx, { code: "c", state }, g.fetcher)).rejects.toMatchObject({ code: "SCOPE" });
      expect(g.calls.some((c) => c.url.includes("/revoke"))).toBe(true);
      expect(all(ctx.db, "SELECT * FROM oauth_connections")).toHaveLength(0);
    }
  });

  it("stores the token encrypted and connects with access None", async () => {
    const ctx = seededCtx();
    const g = await connect(ctx, "gmail");
    const tokenCall = g.calls.find((c) => c.url.includes("/token"))!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).get("code_verifier")).toBeTruthy();
    const row = all<{ token_ciphertext: string }>(ctx.db, "SELECT token_ciphertext FROM oauth_connections WHERE service_id = 'gmail'")[0];
    expect(row.token_ciphertext).not.toContain("access-1");
    expect(row.token_ciphertext).not.toContain("refresh-1");
    const svc = all<{ connection_state: string; access_level: string }>(ctx.db, "SELECT connection_state, access_level FROM services WHERE id = 'gmail'")[0];
    expect(svc).toEqual({ connection_state: "connected", access_level: "none" });
  });
});

describe("data access", () => {
  it("agents cannot read Gmail until both the service and the agent are granted Read", async () => {
    const ctx = seededCtx();
    await connect(ctx, "gmail");
    const budget = () => new RunBudget(3, 5000);
    await expect(callTool(ctx, "inbox", "gmail.sync", {}, budget())).rejects.toThrow(PolicyError);
    setServiceLevel(ctx, "gmail", "read");
    await expect(callTool(ctx, "inbox", "gmail.sync", {}, budget())).rejects.toThrow(PolicyError);
    setAgentLevel(ctx, "inbox", "gmail", "read");
    expect(() => setServiceLevel(ctx, "gmail", "prepare")).toThrow(/at most Read/);
  });

  it("syncs Gmail headers only, skips bad ids, and flags only personal unread mail as needing a reply", async () => {
    const ctx = seededCtx();
    const g = await connect(ctx, "gmail");
    await syncGmail(ctx, g.fetcher);
    const rows = all<{ sender: string; subject: string; snippet: string; needs_reply: number; source: string }>(ctx.db, "SELECT sender, subject, snippet, needs_reply, source FROM messages WHERE source = 'gmail' ORDER BY subject");
    expect(rows).toEqual([
      { sender: "deals@shop.example", subject: "50% off", snippet: "", needs_reply: 0, source: "gmail" },
      { sender: "Ana <ana@example.com>", subject: "Dinner Friday?", snippet: "", needs_reply: 1, source: "gmail" },
    ]);
    expect(g.calls.every((c) => !c.url.includes("format=full") && !c.url.includes("evil"))).toBe(true);
    expect(g.calls.filter((c) => c.url.includes("format=metadata"))).toHaveLength(2);
  });

  it("demo tools never see real Gmail rows", async () => {
    const ctx = seededCtx();
    const g = await connect(ctx, "gmail");
    await syncGmail(ctx, g.fetcher);
    const demo = await callTool(ctx, "inbox", "inbox.list_messages", { limit: 25 }, new RunBudget(3, 5000));
    expect(demo.every((m) => m.source === "demo")).toBe(true);
  });

  it("syncs calendar titles and times, dropping cancelled events", async () => {
    const ctx = seededCtx();
    const g = await connect(ctx, "google-calendar");
    const r = await syncCalendar(ctx, g.fetcher);
    expect(r.events).toBe(1);
    expect(all<{ title: string }>(ctx.db, "SELECT title FROM events WHERE source = 'google-calendar'")).toEqual([{ title: "Team lunch" }]);
    const call = g.calls.find((c) => c.url.includes("/events"))!;
    expect(new URL(call.url).searchParams.get("fields")).not.toMatch(/description|attendees/);
  });

  it("refreshes an expired access token", async () => {
    const ctx = seededCtx();
    const g = await connect(ctx, "gmail");
    const sealed = seal(JSON.stringify({ access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() - 1000 }), "gmail");
    run(ctx.db, "UPDATE oauth_connections SET token_ciphertext = ? WHERE service_id = 'gmail'", sealed);
    await syncGmail(ctx, g.fetcher);
    const apiCall = g.calls.filter((c) => c.url.includes("gmail.googleapis.com")).at(-1)!;
    expect(new Headers(apiCall.init?.headers).get("authorization")).toBe("Bearer access-2");
  });

  it("a token revoked on Google's side disconnects locally", async () => {
    const ctx = seededCtx();
    await connect(ctx, "gmail");
    const sealed = seal(JSON.stringify({ access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() - 1000 }), "gmail");
    run(ctx.db, "UPDATE oauth_connections SET token_ciphertext = ? WHERE service_id = 'gmail'", sealed);
    await expect(syncGmail(ctx, fakeGoogle({ refreshError: "invalid_grant" }).fetcher)).rejects.toMatchObject({ code: "TOKEN" });
    expect(all(ctx.db, "SELECT * FROM oauth_connections")).toHaveLength(0);
    expect(all<{ connection_state: string }>(ctx.db, "SELECT connection_state FROM services WHERE id = 'gmail'")[0].connection_state).toBe("revoked");
  });
});

describe("disconnect", () => {
  it("revokes at Google, deletes the token and all synced data", async () => {
    const ctx = seededCtx();
    const g = await connect(ctx, "gmail");
    await syncGmail(ctx, g.fetcher);
    await disconnectGoogle(ctx, "gmail", g.fetcher);
    const revoke = g.calls.find((c) => c.url.includes("/revoke"))!;
    expect(new URLSearchParams(String(revoke.init?.body)).get("token")).toBe("refresh-1");
    expect(all(ctx.db, "SELECT * FROM oauth_connections")).toHaveLength(0);
    expect(all(ctx.db, "SELECT * FROM messages WHERE source = 'gmail'")).toHaveLength(0);
  });

  it("a demo reset keeps real connections intact", async () => {
    const ctx = seededCtx();
    await connect(ctx, "gmail");
    const { resetDemo } = await import("@/server/seed/seed");
    resetDemo(ctx);
    expect(all(ctx.db, "SELECT * FROM oauth_connections")).toHaveLength(1);
    expect(all<{ connection_state: string }>(ctx.db, "SELECT connection_state FROM services WHERE id = 'gmail'")[0].connection_state).toBe("connected");
  });
});
