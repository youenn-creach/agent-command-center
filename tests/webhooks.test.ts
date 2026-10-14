import { describe, expect, it } from "vitest";
import { all, run } from "@/server/db";
import { addWebhook, callWebhook, listWebhooks, removeWebhook, type WebhookFetcher } from "@/server/connectors/webhooks";
import { approveAction, executeAction, proposeAction, ApprovalError, webhookConnector } from "@/server/approvals";
import { PolicyError } from "@/server/policy/engine";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { seal } from "@/server/connectors/secretBox";
import { dashboardState } from "@/server/state";
import { seededCtx } from "./helpers";

const SECRET_URL = "https://hooks.zapier.com/hooks/catch/123456/abcdef-secret/";

function recorder(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetcher: WebhookFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status };
  };
  return { calls, fetcher };
}

function setup() {
  const ctx = seededCtx();
  const id = addWebhook(ctx, { name: "Todoist", description: "Adds a task", url: SECRET_URL });
  return { ctx, id };
}

function grant(ctx: ReturnType<typeof seededCtx>, id: string) {
  setServiceLevel(ctx, id, "write_with_approval");
  setAgentLevel(ctx, "follow_up", id, "write_with_approval");
}

const propose = (ctx: ReturnType<typeof seededCtx>, id: string, text = "buy milk") =>
  proposeAction(ctx, { agentId: "follow_up", serviceId: id, kind: "webhook", title: "task", payload: { hookId: id, fields: { text } }, idempotencyKey: `k:${text}` });

describe("registering webhooks", () => {
  it("stores the URL encrypted, exposes only host and fingerprint, and starts with access None", async () => {
    const { ctx, id } = setup();
    const row = all<{ url_ciphertext: string }>(ctx.db, "SELECT url_ciphertext FROM webhooks")[0];
    expect(row.url_ciphertext).not.toContain("abcdef-secret");
    expect(JSON.stringify(listWebhooks(ctx))).not.toContain("abcdef-secret");
    expect(JSON.stringify(await dashboardState(ctx))).not.toContain("abcdef-secret");
    expect(all<{ access_level: string }>(ctx.db, "SELECT access_level FROM services WHERE id = ?", id)[0].access_level).toBe("none");
  });

  it.each(["http://hooks.zapier.com/x", "https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://localhost/hook", "https://user:pw@hooks.example.com/x"])("refuses %s", (url) => {
    const ctx = seededCtx();
    expect(() => addWebhook(ctx, { name: "x hook", url })).toThrow();
  });
});

describe("calling webhooks", () => {
  it("agents need permission even to propose", () => {
    const { ctx, id } = setup();
    expect(() => propose(ctx, id)).toThrow(PolicyError);
  });

  it("a kind cannot target the wrong service", () => {
    const { ctx, id } = setup();
    grant(ctx, id);
    expect(() => proposeAction(ctx, { agentId: "follow_up", serviceId: id, kind: "reminder", title: "x", payload: { text: "x" }, idempotencyKey: "r" })).toThrow(ApprovalError);
    expect(() => proposeAction(ctx, { agentId: "follow_up", serviceId: "local-tasks", kind: "webhook", title: "x", payload: { hookId: id, fields: { text: "x" } }, idempotencyKey: "w" })).toThrow(ApprovalError);
  });

  it("nothing is sent before approval; after approval exactly one POST with an idempotency key", async () => {
    const { ctx, id } = setup();
    grant(ctx, id);
    const rec = recorder();
    const a = propose(ctx, id);
    await expect(executeAction(ctx, a.id, webhookConnector(ctx, rec.fetcher))).rejects.toThrow(/Only approved/);
    expect(rec.calls).toHaveLength(0);
    approveAction(ctx, a.id, a.payload_hash, "user");
    await executeAction(ctx, a.id, webhookConnector(ctx, rec.fetcher));
    await executeAction(ctx, a.id, webhookConnector(ctx, rec.fetcher));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].url).toBe(SECRET_URL);
    expect(rec.calls[0].headers["idempotency-key"]).toBe(a.id);
    expect(JSON.parse(rec.calls[0].body)).toMatchObject({ text: "buy milk", _meta: { actionId: a.id } });
    expect(all<{ status: string }>(ctx.db, "SELECT status FROM actions WHERE id = ?", a.id)[0].status).toBe("executed");
  });

  it("replacing the URL after approval invalidates the approval", async () => {
    const { ctx, id } = setup();
    grant(ctx, id);
    const rec = recorder();
    const a = propose(ctx, id);
    approveAction(ctx, a.id, a.payload_hash, "user");
    run(ctx.db, "UPDATE webhooks SET url_ciphertext = ?, url_fingerprint = 'different' WHERE id = ?", seal("https://evil.example.com/hook", id), id);
    const out = await executeAction(ctx, a.id, webhookConnector(ctx, rec.fetcher));
    expect(out.status).toBe("failed");
    expect(out.result).toMatch(/URL changed after approval/);
    expect(rec.calls).toHaveLength(0);
  });

  it("a non-2xx answer (including redirects) marks the action failed", async () => {
    const { ctx, id } = setup();
    grant(ctx, id);
    for (const status of [500, 302]) {
      const a = propose(ctx, id, `case ${status}`);
      approveAction(ctx, a.id, a.payload_hash, "user");
      const out = await executeAction(ctx, a.id, webhookConnector(ctx, recorder(status).fetcher));
      expect(out.status).toBe("failed");
    }
  });

  it("payload limits are enforced", () => {
    const { ctx, id } = setup();
    grant(ctx, id);
    expect(() => proposeAction(ctx, { agentId: "follow_up", serviceId: id, kind: "webhook", title: "x", payload: { hookId: id, fields: { text: "x".repeat(5000) } }, idempotencyKey: "big" })).toThrow(/Invalid webhook payload/);
  });

  it("removing a webhook cancels its pending proposals and revokes the service", () => {
    const { ctx, id } = setup();
    grant(ctx, id);
    const a = propose(ctx, id);
    removeWebhook(ctx, id);
    expect(all<{ status: string }>(ctx.db, "SELECT status FROM actions WHERE id = ?", a.id)[0].status).toBe("cancelled");
    expect(all(ctx.db, "SELECT * FROM services WHERE id = ?", id)).toHaveLength(0);
  });

  it("callWebhook refuses an action whose destination was not bound to this URL", async () => {
    const { ctx, id } = setup();
    await expect(callWebhook(ctx, { id: "x", destination: `webhook:${id}#bogus`, payload: JSON.stringify({ hookId: id, fields: { text: "t" } }), approved_at: null }, recorder().fetcher)).rejects.toThrow(/changed after approval/);
  });
});

describe("command bar", () => {
  it("“trigger <name>: …” only creates a proposal, and explains missing permission", async () => {
    const { ctx, id } = setup();
    const denied = await runCommand(ctx, "trigger Todoist: buy milk", workflows);
    expect(denied.reply).toMatch(/isn't allowed/);
    grant(ctx, id);
    const ok = await runCommand(ctx, "trigger todoist: buy milk", workflows);
    expect(ok.intent).toBe("automation");
    const actions = all<{ status: string; kind: string }>(ctx.db, "SELECT status, kind FROM actions WHERE service_id = ?", id);
    expect(actions).toEqual([{ status: "proposed", kind: "webhook" }]);
  });
});
