import { describe, expect, it } from "vitest";
import { ACCESS_LEVELS, intersect, allows, rank, type AccessLevel } from "@/server/policy/levels";
import { authorize, effectiveAccess, PolicyError } from "@/server/policy/engine";
import { disconnectService, enforceAgentProfiles, permissionMatrix, PermissionChangeError, setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { agentMaxLevel } from "@/server/policy/profiles";
import { WORKFLOW_CATALOG } from "@/server/agents/catalog";
import { run, all } from "@/server/db";
import { seededCtx } from "./helpers";

describe("permission intersection", () => {
  it("is the more restrictive of service and agent levels, for every pair", () => {
    for (const a of ACCESS_LEVELS) {
      for (const b of ACCESS_LEVELS) {
        const r = intersect(a, b);
        expect(r).toBe(ACCESS_LEVELS[Math.min(ACCESS_LEVELS.indexOf(a), ACCESS_LEVELS.indexOf(b))]);
        expect(intersect(b, a)).toBe(r);
      }
    }
  });

  it("applies to live checks: agent write_with_approval on a prepare-level service is only prepare", () => {
    const ctx = seededCtx();
    const eff = effectiveAccess(ctx, "follow_up", "demo-mail");
    expect(eff.agentLevel).toBe("write_with_approval");
    expect(eff.serviceLevel).toBe("prepare");
    expect(eff.level).toBe("prepare");
    expect(eff.reason).toMatch(/service-level/);
  });

  it("applies the other way: a generous service cannot lift a narrow agent grant", () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    expect(effectiveAccess(ctx, "inbox", "demo-mail").level).toBe("read");
    expect(allows(effectiveAccess(ctx, "inbox", "demo-mail").level, "prepare")).toBe(false);
  });

  it("gives an agent with no grant no access", () => {
    const ctx = seededCtx();
    expect(effectiveAccess(ctx, "chief_of_staff", "demo-mail").level).toBe("none");
    expect(effectiveAccess(ctx, "inbox", "demo-notes").level).toBe("none");
  });

  it("treats disconnected/revoked services as none regardless of stored levels", () => {
    const ctx = seededCtx();
    disconnectService(ctx, "demo-notes");
    expect(effectiveAccess(ctx, "knowledge", "demo-notes").level).toBe("none");
    expect(effectiveAccess(ctx, "knowledge", "gmail").level).toBe("none");
  });

  it("clamps tampered rows: auto_act or above-ceiling levels in the DB are never honoured", () => {
    const ctx = seededCtx();
    run(ctx.db, "UPDATE services SET access_level = 'auto_act' WHERE id = 'demo-notes'");
    run(ctx.db, "UPDATE agent_permissions SET access_level = 'auto_act' WHERE agent_id = 'knowledge' AND service_id = 'demo-notes'");
    expect(effectiveAccess(ctx, "knowledge", "demo-notes").level).toBe("read"); // max_level of demo-notes is read
  });
});

describe("permission administration", () => {
  it("refuses auto_act in the MVP", () => {
    const ctx = seededCtx();
    expect(() => setServiceLevel(ctx, "demo-mail", "auto_act")).toThrow(PermissionChangeError);
    expect(() => setAgentLevel(ctx, "follow_up", "demo-mail", "auto_act")).toThrow(PermissionChangeError);
  });

  it("refuses levels above a service's ceiling", () => {
    const ctx = seededCtx();
    expect(() => setServiceLevel(ctx, "demo-notes", "prepare")).toThrow(/at most Read/);
  });

  it("refuses granting access to a service that is not connected", () => {
    const ctx = seededCtx();
    expect(() => setServiceLevel(ctx, "gmail", "read")).toThrow(/Connect the service/);
  });

  it("records permission changes in the activity log", () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "write_with_approval");
    const log = all<{ kind: string; summary: string }>(ctx.db, "SELECT kind, summary FROM activity WHERE kind = 'permission_change'");
    expect(log.at(-1)?.summary).toMatch(/Prepare → Write with approval/);
  });
});

describe("authorize", () => {
  it("throws PolicyError and logs a denial", () => {
    const ctx = seededCtx();
    expect(() => authorize(ctx, "inbox", "demo-calendar", "read", "test read")).toThrow(PolicyError);
    const denials = all(ctx.db, "SELECT * FROM activity WHERE kind = 'permission_denied'");
    expect(denials).toHaveLength(1);
  });
});

describe("role profiles", () => {
  it("fit every seeded grant and every workflow requirement", () => {
    const ctx = seededCtx();
    for (const g of all<{ agent_id: string; service_id: string; access_level: AccessLevel }>(ctx.db, "SELECT * FROM agent_permissions")) {
      expect(rank(g.access_level), `${g.agent_id} on ${g.service_id}`).toBeLessThanOrEqual(rank(agentMaxLevel(g.agent_id, g.service_id)));
    }
    for (const w of WORKFLOW_CATALOG) {
      for (const r of w.requirements) {
        expect(rank(r.level), `${w.workflow}: ${r.agentId} on ${r.serviceId}`).toBeLessThanOrEqual(rank(agentMaxLevel(r.agentId, r.serviceId)));
      }
    }
  });

  it("give webhooks to the Follow-up agent only", () => {
    expect(agentMaxLevel("follow_up", "hook-deploy")).toBe("write_with_approval");
    expect(agentMaxLevel("inbox", "hook-deploy")).toBe("none");
    expect(agentMaxLevel("unknown_agent", "demo-mail")).toBe("none");
  });

  it("refuse grants outside an agent's role, with a reason", () => {
    const ctx = seededCtx();
    expect(() => setAgentLevel(ctx, "inbox", "demo-notes", "read")).toThrow(/never uses/);
    expect(() => setAgentLevel(ctx, "chief_of_staff", "demo-mail", "read")).toThrow(/only coordinates/);
    expect(() => setAgentLevel(ctx, "inbox", "demo-mail", "prepare")).toThrow(/at most Read/);
    expect(effectiveAccess(ctx, "inbox", "demo-notes").level).toBe("none");
  });

  it("clamp tampered rows to the role, and trim them on startup with a log entry", () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-notes", "read");
    run(ctx.db, "INSERT OR REPLACE INTO agent_permissions VALUES ('inbox', 'demo-notes', 'read')");
    run(ctx.db, "INSERT OR REPLACE INTO agent_permissions VALUES ('inbox', 'demo-mail', 'write_with_approval')");
    expect(effectiveAccess(ctx, "inbox", "demo-notes").level).toBe("none");
    expect(effectiveAccess(ctx, "inbox", "demo-mail").agentLevel).toBe("read");

    expect(enforceAgentProfiles(ctx)).toBe(2);
    const grants = all<{ service_id: string; access_level: string }>(ctx.db, "SELECT service_id, access_level FROM agent_permissions WHERE agent_id = 'inbox' ORDER BY service_id");
    expect(grants).toEqual([{ service_id: "demo-mail", access_level: "read" }]);
    const log = all<{ summary: string }>(ctx.db, "SELECT summary FROM activity WHERE kind = 'permission_change' AND summary LIKE 'Trimmed%'");
    expect(log).toHaveLength(2);
    expect(enforceAgentProfiles(ctx)).toBe(0); // idempotent
  });

  it("show in the permission matrix", () => {
    const ctx = seededCtx();
    const inbox = permissionMatrix(ctx).find((a) => a.agentId === "inbox")!;
    const notes = inbox.cells.find((c) => c.serviceId === "demo-notes")!;
    expect(notes.agentMax).toBe("none");
    expect(notes.outOfRole).toMatch(/never uses/);
    expect(inbox.cells.find((c) => c.serviceId === "demo-mail")).toMatchObject({ agentMax: "read", outOfRole: "" });
  });
});
