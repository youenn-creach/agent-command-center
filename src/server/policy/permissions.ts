import { all, one, run, type Ctx } from "../db";
import { logActivity } from "../activity";
import { reconcileJobs } from "../scheduler/scheduler";
import { effectiveAccess } from "./engine";
import { LEVEL_LABELS, isGrantable, rank, type AccessLevel } from "./levels";
import { agentMaxLevel, profileReason } from "./profiles";

/**
 * Permission administration. Only the user (via authenticated UI/API routes) calls these;
 * no agent tool and no MCP tool can reach this module, so agents cannot grant themselves
 * or each other access.
 */

export class PermissionChangeError extends Error {}

export interface ServiceView {
  id: string;
  name: string;
  description: string;
  kind: "demo" | "real";
  connection_state: "connected" | "disconnected" | "revoked";
  access_level: AccessLevel;
  max_level: AccessLevel;
  scopes: string[];
  last_sync_at: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  role: string;
  description: string;
  status: string;
  last_run_at: string | null;
  last_error: string | null;
  /** While running: the tool or workflow it is on (e.g. "gmail.list_messages"). */
  current_step: string | null;
}

export function listServices(ctx: Ctx): ServiceView[] {
  return all<Omit<ServiceView, "scopes"> & { scopes: string }>(ctx.db, "SELECT * FROM services ORDER BY kind, name").map((s) => ({
    ...s,
    scopes: JSON.parse(s.scopes) as string[],
  }));
}

export function listAgents(ctx: Ctx): AgentView[] {
  return all<AgentView>(ctx.db, "SELECT * FROM agents ORDER BY CASE id WHEN 'chief_of_staff' THEN 0 ELSE 1 END, name");
}

export function permissionMatrix(ctx: Ctx) {
  const services = listServices(ctx);
  const agents = listAgents(ctx);
  const grants = all<{ agent_id: string; service_id: string; access_level: AccessLevel }>(ctx.db, "SELECT * FROM agent_permissions");
  return agents.map((a) => ({
    agentId: a.id,
    cells: services.map((s) => {
      const grant = grants.find((g) => g.agent_id === a.id && g.service_id === s.id)?.access_level ?? "none";
      const eff = effectiveAccess(ctx, a.id, s.id);
      const max = agentMaxLevel(a.id, s.id);
      return { serviceId: s.id, agentLevel: grant, effective: eff.level, reason: eff.reason, agentMax: max, outOfRole: profileReason(a.id, s.id, a.name, s.name) };
    }),
  }));
}

function assertLevel(level: AccessLevel, ceiling: AccessLevel) {
  if (!isGrantable(level)) throw new PermissionChangeError(`${LEVEL_LABELS[level]} cannot be granted in this version.`);
  if (rank(level) > rank(ceiling)) {
    throw new PermissionChangeError(`This service supports at most ${LEVEL_LABELS[ceiling]}.`);
  }
}

export function setServiceLevel(ctx: Ctx, serviceId: string, level: AccessLevel) {
  const svc = one<ServiceView & { scopes: string }>(ctx.db, "SELECT * FROM services WHERE id = ?", serviceId);
  if (!svc) throw new PermissionChangeError("Unknown service");
  assertLevel(level, svc.max_level);
  if (svc.connection_state !== "connected" && level !== "none") {
    throw new PermissionChangeError("Connect the service before granting access.");
  }
  run(ctx.db, "UPDATE services SET access_level = ? WHERE id = ?", level, serviceId);
  logActivity(ctx, {
    actor: "user",
    kind: "permission_change",
    serviceId,
    outcome: "info",
    summary: `${svc.name}: service access ${LEVEL_LABELS[svc.access_level]} → ${LEVEL_LABELS[level]}`,
  });
  reconcileJobs(ctx);
}

export function setAgentLevel(ctx: Ctx, agentId: string, serviceId: string, level: AccessLevel) {
  const agent = one<{ name: string }>(ctx.db, "SELECT name FROM agents WHERE id = ?", agentId);
  const svc = one<{ name: string; max_level: AccessLevel }>(ctx.db, "SELECT name, max_level FROM services WHERE id = ?", serviceId);
  if (!agent || !svc) throw new PermissionChangeError("Unknown agent or service");
  assertLevel(level, svc.max_level);
  const roleMax = agentMaxLevel(agentId, serviceId);
  if (rank(level) > rank(roleMax)) {
    throw new PermissionChangeError(roleMax === "none" ? `${profileReason(agentId, serviceId, agent.name, svc.name)}, so it can't be granted access.` : `${agent.name} needs at most ${LEVEL_LABELS[roleMax]} on ${svc.name}.`);
  }
  const before = one<{ access_level: AccessLevel }>(ctx.db, "SELECT access_level FROM agent_permissions WHERE agent_id = ? AND service_id = ?", agentId, serviceId)?.access_level ?? "none";
  run(
    ctx.db,
    `INSERT INTO agent_permissions (agent_id, service_id, access_level) VALUES (?, ?, ?)
     ON CONFLICT(agent_id, service_id) DO UPDATE SET access_level = excluded.access_level`,
    agentId,
    serviceId,
    level,
  );
  logActivity(ctx, {
    actor: "user",
    kind: "permission_change",
    agentId,
    serviceId,
    outcome: "info",
    summary: `${agent.name} on ${svc.name}: ${LEVEL_LABELS[before]} → ${LEVEL_LABELS[level]}`,
  });
  reconcileJobs(ctx);
}

/** Disconnect = revoke: access drops to None immediately and dependent schedules are blocked. */
export function disconnectService(ctx: Ctx, serviceId: string) {
  const svc = one<{ name: string; kind: string }>(ctx.db, "SELECT name, kind FROM services WHERE id = ?", serviceId);
  if (!svc) throw new PermissionChangeError("Unknown service");
  run(ctx.db, "UPDATE services SET connection_state = 'revoked', access_level = 'none' WHERE id = ?", serviceId);
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId, outcome: "info", summary: `Disconnected ${svc.name} and revoked access` });
  reconcileJobs(ctx);
}

/** Reconnects a demo service. Real services reconnect through their own flow (Google sign-in, Settings for weather and webhooks). */
export function reconnectDemoService(ctx: Ctx, serviceId: string) {
  const svc = one<{ name: string; kind: string }>(ctx.db, "SELECT name, kind FROM services WHERE id = ?", serviceId);
  if (!svc) throw new PermissionChangeError("Unknown service");
  // Webhooks are re-enabled here too (their URL is still stored); access stays None.
  if (svc.kind !== "demo" && !serviceId.startsWith("hook-")) throw new PermissionChangeError("Reconnect this service from its own setup (Google sign-in, or Settings).");
  run(ctx.db, "UPDATE services SET connection_state = 'connected', last_sync_at = ? WHERE id = ?", ctx.now().toISOString(), serviceId);
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId, outcome: "info", summary: `Reconnected ${svc.name}. Access stays at its current level.` });
  reconcileJobs(ctx);
}

/**
 * Trims stored grants that exceed an agent's role profile (e.g. made before profiles existed).
 * The policy engine already ignores the excess; this keeps the matrix truthful. Each change is logged.
 */
export function enforceAgentProfiles(ctx: Ctx): number {
  const grants = all<{ agent_id: string; service_id: string; access_level: AccessLevel }>(ctx.db, "SELECT * FROM agent_permissions");
  let changed = 0;
  for (const g of grants) {
    const max = agentMaxLevel(g.agent_id, g.service_id);
    if (rank(g.access_level) <= rank(max)) continue;
    if (max === "none") run(ctx.db, "DELETE FROM agent_permissions WHERE agent_id = ? AND service_id = ?", g.agent_id, g.service_id);
    else run(ctx.db, "UPDATE agent_permissions SET access_level = ? WHERE agent_id = ? AND service_id = ?", max, g.agent_id, g.service_id);
    logActivity(ctx, {
      actor: "system",
      kind: "permission_change",
      agentId: g.agent_id,
      serviceId: g.service_id,
      outcome: "info",
      summary: `Trimmed a grant outside the agent's role: ${g.agent_id} on ${g.service_id} ${LEVEL_LABELS[g.access_level]} → ${LEVEL_LABELS[max]}`,
    });
    changed++;
  }
  if (changed) reconcileJobs(ctx);
  return changed;
}
