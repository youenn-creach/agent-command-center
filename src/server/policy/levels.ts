import { z } from "zod";

/**
 * Access levels are ordered: each level includes everything below it.
 * `auto_act` exists in the model so the UI can explain it, but the MVP refuses to grant it.
 */
export const ACCESS_LEVELS = ["none", "read", "prepare", "write_with_approval", "auto_act"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const AccessLevelSchema = z.enum(ACCESS_LEVELS);

export const GRANTABLE_LEVELS: readonly AccessLevel[] = ["none", "read", "prepare", "write_with_approval"];

export const LEVEL_LABELS: Record<AccessLevel, string> = {
  none: "None",
  read: "Read",
  prepare: "Prepare",
  write_with_approval: "Write with approval",
  auto_act: "Auto-act (disabled in MVP)",
};

export function rank(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

/** Effective permission is the more restrictive of the service-level and agent-level grants. */
export function intersect(a: AccessLevel, b: AccessLevel): AccessLevel {
  return rank(a) <= rank(b) ? a : b;
}

export function allows(granted: AccessLevel, required: AccessLevel): boolean {
  return rank(granted) >= rank(required);
}

export function isGrantable(level: AccessLevel): boolean {
  return GRANTABLE_LEVELS.includes(level);
}
