import { one, type Ctx } from "../db";
import { logActivity } from "../activity";
import { allows, intersect, type AccessLevel } from "./levels";
import { agentMaxLevel } from "./profiles";
import { hiddenReason } from "../mode";

export class PolicyError extends Error {
  readonly code = "POLICY_DENIED";
  constructor(
    message: string,
    readonly detail: { agentId: string; serviceId: string; required: AccessLevel; effective: AccessLevel },
  ) {
    super(message);
  }
}

interface ServiceRow {
  id: string;
  kind: string;
  connection_state: string;
  access_level: AccessLevel;
  max_level: AccessLevel;
}

/** Services that can never be written to, whatever the database says. */
export const READ_ONLY_SERVICES = new Set(["gmail", "google-calendar", "weather", "demo-notes", "public-news", "web-search"]);

export interface EffectiveAccess {
  level: AccessLevel;
  serviceLevel: AccessLevel;
  agentLevel: AccessLevel;
  reason: string;
}

/**
 * The single source of truth for "may this agent do X on this service right now?".
 * Every tool call, approval and scheduled run goes through here; the UI only edits the inputs.
 */
export function effectiveAccess(ctx: Ctx, agentId: string, serviceId: string): EffectiveAccess {
  const service = one<ServiceRow>(
    ctx.db,
    "SELECT id, kind, connection_state, access_level, max_level FROM services WHERE id = ?",
    serviceId,
  );
  if (!service) return { level: "none", serviceLevel: "none", agentLevel: "none", reason: "Unknown service" };

  const grant = one<{ access_level: AccessLevel }>(
    ctx.db,
    "SELECT access_level FROM agent_permissions WHERE agent_id = ? AND service_id = ?",
    agentId,
    serviceId,
  );
  // An agent never exceeds its role profile, whatever is stored (see profiles.ts).
  const agentLevel: AccessLevel = intersect(grant?.access_level ?? "none", agentMaxLevel(agentId, serviceId));

  // Not part of this instance (personal app vs demo; see mode.ts): off for every agent.
  const hidden = hiddenReason(service);
  if (hidden) return { level: "none", serviceLevel: "none", agentLevel, reason: hidden };

  if (service.connection_state !== "connected") {
    return { level: "none", serviceLevel: "none", agentLevel, reason: `Service is ${service.connection_state}` };
  }

  // Defence in depth: a stored level above the service ceiling (or auto_act) is clamped, not trusted.
  // Read-only services are capped in code too, so even a tampered max_level can't open a write path.
  const ceiling: AccessLevel = READ_ONLY_SERVICES.has(serviceId) ? "read" : "write_with_approval";
  const serviceLevel = intersect(intersect(service.access_level, service.max_level), ceiling);
  const level = intersect(serviceLevel, intersect(agentLevel, ceiling));
  const reason =
    level === serviceLevel && level === agentLevel
      ? "Service and agent grants match"
      : level === serviceLevel
        ? "Limited by the service-level grant"
        : "Limited by the agent-level grant";
  return { level, serviceLevel, agentLevel, reason };
}

export function check(ctx: Ctx, agentId: string, serviceId: string, required: AccessLevel): boolean {
  return allows(effectiveAccess(ctx, agentId, serviceId).level, required);
}

/** Throws (and records the denial) unless the effective permission satisfies `required`. */
export function authorize(
  ctx: Ctx,
  agentId: string,
  serviceId: string,
  required: AccessLevel,
  purpose: string,
): EffectiveAccess {
  const access = effectiveAccess(ctx, agentId, serviceId);
  if (!allows(access.level, required)) {
    logActivity(ctx, {
      actor: agentId,
      kind: "permission_denied",
      agentId,
      serviceId,
      outcome: "denied",
      summary: `Denied: ${purpose} needs ${required}, effective is ${access.level}`,
      detail: { required, effective: access.level, reason: access.reason },
    });
    throw new PolicyError(`${purpose} requires "${required}" but effective access is "${access.level}" (${access.reason}).`, {
      agentId,
      serviceId,
      required,
      effective: access.level,
    });
  }
  return access;
}
