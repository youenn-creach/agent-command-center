import { config } from "./config";
import { one, type Ctx } from "./db";

/**
 * One codebase, two instances: a personal app (your accounts only) and a demo (fictional data only),
 * each with its own data directory. "mixed" (the default) shows both, as before.
 *
 * Hidden services are not just hidden in the UI: the policy engine treats them as off, so no agent
 * can use them, and their seeded rows are filtered out of every view. Nothing is deleted, so
 * switching modes is reversible.
 */
export type AppMode = "personal" | "demo" | "mixed";

/** Fictional stand-ins with no real counterpart in the personal app. */
export const DEMO_ONLY_SERVICES = new Set(["demo-mail", "demo-calendar"]);

export function appMode(): AppMode {
  return config().ACC_MODE;
}

/** Why a service is off in this instance, or null if it is part of it. */
export function hiddenReason(service: { id: string; kind: string }, mode: AppMode = appMode()): string | null {
  if (mode === "personal" && DEMO_ONLY_SERVICES.has(service.id)) return "Demo services are not part of the personal app";
  if (mode === "demo" && service.kind === "real") return "Real accounts are off in the demo";
  return null;
}

/** Seeded example workflows with fictional content (e.g. a car-insurance reminder): demo only. */
export const DEMO_ONLY_WORKFLOWS = new Set(["insurance_reminder"]);

/** True if the service exists but isn't part of this instance (see hiddenReason). */
export function serviceHidden(ctx: Ctx, serviceId: string): boolean {
  const s = one<{ id: string; kind: string }>(ctx.db, "SELECT id, kind FROM services WHERE id = ?", serviceId);
  return !!s && hiddenReason(s) !== null;
}

/** SQL fragment for tables with an is_demo column: the personal app never shows seeded fictional rows. */
export function demoRowsFilter(alias = ""): string {
  return appMode() === "personal" ? ` AND ${alias ? `${alias}.` : ""}is_demo = 0` : "";
}

export class ModeError extends Error {
  readonly code = "MODE_DISABLED";
}

/**
 * "Reset demo data" empties whole tables (activity log, reminders, action history, briefings). In the
 * personal app those hold real data, so the reset is refused there: it belongs to the demo instance.
 */
export function assertDemoResetAllowed() {
  if (appMode() === "personal") throw new ModeError("Resetting demo data is only for the demo instance: in your personal app it would delete your real history. Use the demo on its own port.");
}

/** Connecting a real account (Google, weather, webhooks) is refused in the demo instance. */
export function assertRealAccountsAllowed(what: string) {
  if (appMode() === "demo") throw new ModeError(`${what} is off in the demo, which only uses fictional data. Use your personal app for real accounts.`);
}
