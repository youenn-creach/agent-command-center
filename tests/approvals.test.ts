import { describe, expect, it } from "vitest";
import {
  actionHash,
  approveAction,
  ApprovalError,
  cancelAction,
  dismissAction,
  editAction,
  executeAction,
  getAction,
  proposeAction,
  type Connector,
} from "@/server/approvals";
import { effectiveAccess, PolicyError } from "@/server/policy/engine";
import { disconnectService, setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { all, run } from "@/server/db";
import { seededCtx } from "./helpers";

const draft = {
  agentId: "follow_up",
  serviceId: "demo-mail",
  kind: "email_reply" as const,
  title: "Reply to Maria",
  payload: { to: "maria.lopez@example.com", subject: "Re: hike", body: "Count me in!" },
  idempotencyKey: "test:1",
};

function outboxCount(ctx: ReturnType<typeof seededCtx>) {
  return all(ctx.db, "SELECT * FROM simulated_outbox").length;
}

describe("proposing actions", () => {
  it("requires prepare", async () => {
    const ctx = seededCtx();
    expect(() => proposeAction(ctx, { ...draft, agentId: "inbox" })).toThrow(PolicyError); // inbox only has read
  });

  it("is idempotent per key", async () => {
    const ctx = seededCtx();
    const a = proposeAction(ctx, draft);
    const b = proposeAction(ctx, draft);
    expect(a.id).toBe(b.id);
    expect(all(ctx.db, "SELECT * FROM actions")).toHaveLength(1);
  });

  it("validates payloads", async () => {
    const ctx = seededCtx();
    expect(() => proposeAction(ctx, { ...draft, idempotencyKey: "x", payload: { to: "not-an-email", subject: "s", body: "b" } })).toThrow(ApprovalError);
  });
});

describe("approval is required and bound to the exact action", () => {
  it("cannot approve while effective access is below write_with_approval", async () => {
    const ctx = seededCtx();
    const a = proposeAction(ctx, draft);
    expect(() => approveAction(ctx, a.id, a.payload_hash, "user")).toThrow(PolicyError);
    expect(getAction(ctx, a.id).status).toBe("proposed");
  });

  it("cannot execute without approval, even when called directly", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    await expect(executeAction(ctx, a.id)).rejects.toThrow(/Only approved actions/);
    expect(outboxCount(ctx)).toBe(0);
  });

  it("rejects an approval for a hash the user did not see", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    const otherHash = actionHash("email_reply", "demo-mail", "attacker@example.net", { ...draft.payload, to: "attacker@example.net" });
    expect(() => approveAction(ctx, a.id, otherHash, "user")).toThrow(/changed after you reviewed it/);
  });

  it("binds the destination: changing the recipient changes the hash", async () => {
    const h1 = actionHash("email_reply", "demo-mail", "a@example.com", { to: "a@example.com", subject: "s", body: "b" });
    const h2 = actionHash("email_reply", "demo-mail", "b@example.com", { to: "b@example.com", subject: "s", body: "b" });
    const h3 = actionHash("email_reply", "demo-mail", "a@example.com", { body: "b", subject: "s", to: "a@example.com" });
    expect(h1).not.toBe(h2);
    expect(h1).toBe(h3); // key order does not matter
  });

  it("clears the approval when the action is edited", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    const edited = editAction(ctx, a.id, { ...draft.payload, body: "Actually, I can't make it." });
    expect(edited.status).toBe("proposed");
    expect(edited.approved_hash).toBeNull();
    await expect(executeAction(ctx, a.id)).rejects.toThrow(/Only approved actions/);
  });

  it("refuses to execute if the stored payload was tampered with after approval", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    const evil = { ...draft.payload, to: "attacker@example.net" };
    run(ctx.db, "UPDATE actions SET payload = ?, destination = ?, payload_hash = ? WHERE id = ?", JSON.stringify(evil), evil.to, actionHash("email_reply", "demo-mail", evil.to, evil), a.id);
    await expect(executeAction(ctx, a.id)).rejects.toThrow(/does not match/);
    expect(outboxCount(ctx)).toBe(0);
  });

  it("records who approved, when, and the result — without the message body", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    const done = await executeAction(ctx, a.id);
    expect(done.status).toBe("executed");
    expect(done.approved_by).toBe("user");
    expect(done.approved_at).toBeTruthy();
    const log = all<{ summary: string; detail: string }>(ctx.db, "SELECT summary, detail FROM activity");
    expect(JSON.stringify(log)).not.toContain("Count me in!");
  });
});

describe("execution safety", () => {
  it("executes exactly once across retries and double clicks", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    let calls = 0;
    const counting: Connector = {
      execute() {
        calls += 1;
        return { effect: "ok", simulated: true };
      },
    };
    await executeAction(ctx, a.id, counting);
    await executeAction(ctx, a.id, counting);
    await executeAction(ctx, a.id, counting);
    expect(calls).toBe(1);
  });

  it("the simulated side effect itself is unique per action", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    await executeAction(ctx, a.id);
    await executeAction(ctx, a.id);
    expect(outboxCount(ctx)).toBe(1);
  });

  it("a revoke between approval and execution wins", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    disconnectService(ctx, "demo-mail");
    await expect(executeAction(ctx, a.id)).rejects.toThrow(PolicyError);
    expect(outboxCount(ctx)).toBe(0);
  });

  it("reducing the agent grant after approval also blocks execution", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    setAgentLevel(ctx, "follow_up", "demo-mail", "prepare");
    await expect(executeAction(ctx, a.id)).rejects.toThrow(PolicyError);
  });

  it("an execution interrupted mid-call is marked failed (outcome unknown), never retried", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    run(ctx.db, "UPDATE actions SET status = 'executing', updated_at = ? WHERE id = ?", new Date(ctx.now().getTime() - 10 * 60_000).toISOString(), a.id);
    const out = await executeAction(ctx, a.id);
    expect(out.status).toBe("failed");
    expect(out.result).toMatch(/outcome unknown/);
    expect(outboxCount(ctx)).toBe(0);
  });

  it("real Gmail and Calendar can't be written to, even with a tampered database", async () => {
    const ctx = seededCtx();
    // Worst case: someone edits the DB to give Gmail/Calendar a write ceiling and full grants.
    for (const svc of ["gmail", "google-calendar"]) {
      run(ctx.db, "UPDATE services SET connection_state = 'connected', access_level = 'write_with_approval', max_level = 'write_with_approval' WHERE id = ?", svc);
      run(ctx.db, "INSERT OR REPLACE INTO agent_permissions VALUES ('follow_up', ?, 'write_with_approval')", svc);
      // Capped in code: Gmail at read, and Follow-up's role never uses Google Calendar at all.
      expect(effectiveAccess(ctx, "follow_up", svc).level).toBe(svc === "gmail" ? "read" : "none");
    }
    // Sending mail / creating events can't even be aimed at the real services.
    expect(() => proposeAction(ctx, { ...draft, serviceId: "gmail", idempotencyKey: "real-mail" })).toThrow();
    expect(() =>
      proposeAction(ctx, {
        agentId: "follow_up",
        serviceId: "google-calendar",
        kind: "calendar_event",
        title: "x",
        payload: { calendar: "primary", title: "x", startsAt: "2026-10-14T10:00:00+02:00", endsAt: "2026-10-14T11:00:00+02:00" },
        idempotencyKey: "real-event",
      }),
    ).toThrow();
    expect(all(ctx.db, "SELECT * FROM actions WHERE service_id IN ('gmail','google-calendar')")).toHaveLength(0);
    expect(outboxCount(ctx)).toBe(0);
  });

  it("supports cancel after approval and dismiss before it", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const a = proposeAction(ctx, draft);
    approveAction(ctx, a.id, a.payload_hash, "user");
    expect(cancelAction(ctx, a.id).status).toBe("cancelled");
    await expect(executeAction(ctx, a.id)).rejects.toThrow(/Only approved actions/);
    const b = proposeAction(ctx, { ...draft, idempotencyKey: "test:2" });
    expect(dismissAction(ctx, b.id).status).toBe("dismissed");
    expect(() => approveAction(ctx, b.id, b.payload_hash, "user")).toThrow(/Cannot approve/);
  });
});
