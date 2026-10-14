import { describe, expect, it } from "vitest";
import { all } from "@/server/db";
import { buildDraftMime, handleCallback, SCOPES, startAuth, syncGmail, type Fetcher } from "@/server/connectors/google";
import { approveAction, executeAction, gmailDraftConnector, getAction } from "@/server/approvals";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { followupSweep } from "@/server/agents/chiefOfStaff";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { seededCtx } from "./helpers";

/** Fake Google: answers token exchanges with the requested scope, serves 1 inbox message, records draft creations. */
function fakeGoogle() {
  const calls: { url: string; method: string; body?: string }[] = [];
  let lastScope = "";
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
    const u = new URL(url);
    if (u.href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: `tok-${lastScope}`, refresh_token: "r", expires_in: 3600, scope: lastScope });
    if (u.pathname.endsWith("/users/me/messages")) return json({ messages: [{ id: "m1" }] });
    if (u.pathname.endsWith("/users/me/messages/m1"))
      return json({ id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: "1760259600000", payload: { headers: [{ name: "From", value: "Ana López <ana@example.com>" }, { name: "Subject", value: "Dinner Friday?" }, { name: "Message-ID", value: "<abc123@mail.example.com>" }] } });
    if (u.pathname.endsWith("/users/me/drafts") && init?.method === "POST") return json({ id: "draft-1" });
    return json({ error: "unexpected" }, 404);
  };
  return { calls, fetcher, setScope: (s: string) => (lastScope = s) };
}

async function connectBoth(ctx: ReturnType<typeof seededCtx>, g: ReturnType<typeof fakeGoogle>) {
  for (const svc of ["gmail", "gmail-drafts"] as const) {
    g.setScope(SCOPES[svc][0]);
    const state = new URL(startAuth(ctx, svc)).searchParams.get("state");
    await handleCallback(ctx, { code: "c", state }, g.fetcher);
  }
  await syncGmail(ctx, g.fetcher);
}

describe("draft MIME", () => {
  it("builds a threaded, UTF-8 plain-text draft", () => {
    const mime = buildDraftMime({ to: "ana@example.com", subject: "Re: Dîner vendredi ?", body: "Avec plaisir 🙂", inReplyTo: "<abc@x.example>" });
    expect(mime).toContain("To: ana@example.com\r\n");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(mime).toContain("In-Reply-To: <abc@x.example>\r\nReferences: <abc@x.example>");
    const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Avec plaisir 🙂");
  });

  it.each([
    { to: "ana@example.com\r\nBcc: evil@example.net", subject: "x" },
    { to: "ana@example.com", subject: "hi\r\nBcc: evil@example.net" },
    { to: "not-an-address", subject: "x" },
    { to: "a@b.c, evil@example.net", subject: "x" },
  ])("refuses header injection or bad recipients: %o", (d) => {
    expect(() => buildDraftMime({ ...d, body: "b" })).toThrow();
  });
});

describe("Gmail drafts flow", () => {
  it("stores threading data on sync, needs both grants, proposes only, and creates exactly one draft after approval", async () => {
    const ctx = seededCtx();
    const g = fakeGoogle();
    await connectBoth(ctx, g);
    const m = all<{ thread_id: string; rfc_message_id: string }>(ctx.db, "SELECT thread_id, rfc_message_id FROM messages WHERE source = 'gmail'")[0];
    expect(m).toEqual({ thread_id: "t1", rfc_message_id: "<abc123@mail.example.com>" });

    // Only the drafts grant: the Follow-up agent still can't see Gmail → no proposal.
    setServiceLevel(ctx, "gmail-drafts", "write_with_approval");
    setAgentLevel(ctx, "follow_up", "gmail-drafts", "write_with_approval");
    await followupSweep(ctx);
    expect(all(ctx.db, "SELECT * FROM actions WHERE kind = 'email_draft'")).toHaveLength(0);

    // Plus Read on Gmail for the Follow-up agent → a threaded proposal, nothing sent to Gmail yet.
    setServiceLevel(ctx, "gmail", "read");
    setAgentLevel(ctx, "follow_up", "gmail", "read");
    await followupSweep(ctx);
    await followupSweep(ctx); // idempotent
    const actions = all<{ id: string; payload: string; status: string }>(ctx.db, "SELECT id, payload, status FROM actions WHERE kind = 'email_draft'");
    expect(actions).toHaveLength(1);
    expect(JSON.parse(actions[0].payload)).toMatchObject({ to: "ana@example.com", subject: "Re: Dinner Friday?", threadId: "t1", inReplyTo: "<abc123@mail.example.com>" });
    expect(JSON.parse(actions[0].payload).body).toMatch(/^Hi Ana,/);
    expect(g.calls.some((c) => c.url.includes("/drafts"))).toBe(false);

    const a = getAction(ctx, actions[0].id);
    approveAction(ctx, a.id, a.payload_hash, "user");
    const done = await executeAction(ctx, a.id, gmailDraftConnector(ctx, g.fetcher));
    await executeAction(ctx, a.id, gmailDraftConnector(ctx, g.fetcher));
    expect(done.status).toBe("executed");
    expect(done.result).toMatch(/not sent/);
    const draftCalls = g.calls.filter((c) => c.url.includes("/drafts"));
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0].method).toBe("POST");
    expect(JSON.parse(draftCalls[0].body!).message.threadId).toBe("t1");
    // The compose-scoped token never touches send, messages or anything else.
    const composeToken = g.calls.filter((c) => c.url.startsWith("https://gmail.googleapis.com") && !c.url.includes("/users/me/messages"));
    expect(composeToken.every((c) => c.url.endsWith("/users/me/drafts"))).toBe(true);
    expect(g.calls.some((c) => /\/send\b/.test(c.url))).toBe(false);
  });

  it("never creates more than the daily cap of drafts, even when approved", async () => {
    const ctx = seededCtx();
    const g = fakeGoogle();
    await connectBoth(ctx, g);
    const { createGmailDraft, MAX_DRAFTS_PER_DAY } = await import("@/server/connectors/google");
    const now = ctx.now().toISOString();
    for (let i = 0; i < MAX_DRAFTS_PER_DAY; i++) {
      ctx.db.prepare("INSERT INTO actions (id, agent_id, service_id, kind, title, destination, payload, payload_hash, status, idempotency_key, executed_at, created_at, updated_at, is_demo) VALUES (?, 'follow_up', 'gmail-drafts', 'email_draft', 't', 'd', '{}', 'h', 'executed', ?, ?, ?, ?, 0)").run(`a${i}`, `k${i}`, now, now, now);
    }
    await expect(createGmailDraft(ctx, { to: "ana@example.com", subject: "x", body: "y" }, g.fetcher)).rejects.toThrow(/Daily limit/);
    expect(g.calls.some((c) => c.url.endsWith("/drafts"))).toBe(false);
  });

  it("a tampered (broader) stored scope means the token is never used", async () => {
    const ctx = seededCtx();
    const g = fakeGoogle();
    await connectBoth(ctx, g);
    ctx.db.prepare("UPDATE oauth_connections SET scopes = ? WHERE service_id = 'gmail-drafts'").run(JSON.stringify(["https://mail.google.com/"]));
    const { createGmailDraft } = await import("@/server/connectors/google");
    await expect(createGmailDraft(ctx, { to: "ana@example.com", subject: "x", body: "y" }, g.fetcher)).rejects.toThrow(/scopes don't match/);
    expect(g.calls.some((c) => c.url.endsWith("/drafts"))).toBe(false);
  });

  it("disconnecting Gmail drafts revokes only that token and keeps the read-only Gmail connection and data", async () => {
    const ctx = seededCtx();
    const g = fakeGoogle();
    await connectBoth(ctx, g);
    const { disconnectGoogle } = await import("@/server/connectors/google");
    await disconnectGoogle(ctx, "gmail-drafts", g.fetcher);
    expect(all<{ service_id: string }>(ctx.db, "SELECT service_id FROM oauth_connections").map((r) => r.service_id)).toEqual(["gmail"]);
    expect(all(ctx.db, "SELECT * FROM messages WHERE source = 'gmail'")).toHaveLength(1);
    expect(g.calls.filter((c) => c.url.includes("/revoke"))).toHaveLength(1);
  });

  it("command bar: “draft reply to ana: …” proposes a draft with the user's text", async () => {
    const ctx = seededCtx();
    const g = fakeGoogle();
    await connectBoth(ctx, g);
    setServiceLevel(ctx, "gmail-drafts", "write_with_approval");
    setAgentLevel(ctx, "follow_up", "gmail-drafts", "write_with_approval");
    const r = await runCommand(ctx, "draft reply to ana: Friday works, see you at 8!", workflows);
    expect(r.intent).toBe("draft");
    const p = JSON.parse(all<{ payload: string }>(ctx.db, "SELECT payload FROM actions WHERE kind = 'email_draft'")[0].payload);
    expect(p).toMatchObject({ to: "ana@example.com", body: "Friday works, see you at 8!", threadId: "t1" });
  });
});

describe("Connect with Google API", () => {
  it("accepts every Google service the connector defines (regression: Gmail drafts was missing)", async () => {
    const { GOOGLE_SERVICES, GoogleServiceSchema } = await import("@/server/connectors/google");
    for (const service of GOOGLE_SERVICES) expect(GoogleServiceSchema.safeParse(service).success).toBe(true);
    expect(GoogleServiceSchema.safeParse("gmail-drafts").success).toBe(true);
    expect(GoogleServiceSchema.safeParse("drive").success).toBe(false);
    // The route must use this schema rather than its own list.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/oauth/google/route.ts", "utf8")).toMatch(/const Service = GoogleServiceSchema/);
  });
});
