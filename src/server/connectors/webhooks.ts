import { createHash } from "node:crypto";
import { assertRealAccountsAllowed } from "../mode";
import { z } from "zod";
import { fetch as undiciFetch } from "undici";
import { all, one, run, tx, type Ctx } from "../db";
import { logActivity } from "../activity";
import { safeAgent, validateFeedUrl } from "../news/feeds";
import { open, seal } from "./secretBox";

/**
 * Automation webhooks: one generic, user-controlled bridge to Zapier, Make, n8n, IFTTT and the like.
 *
 * Security model (the agent never gets more than "propose"):
 *  - Only the user registers a webhook. Its URL is a capability secret: stored encrypted, shown
 *    only as host + fingerprint, never logged, never sent to the browser or an LLM.
 *  - Each webhook is its own service (None by default, max "Write with approval"), so access is
 *    granted per webhook and per agent like any other service.
 *  - Agents can only propose a call. The user approves the exact JSON; the approval is bound to the
 *    URL's fingerprint, so changing or replacing the URL invalidates pending approvals.
 *  - Execution: https only, SSRF-checked connection, no redirects, 10 s timeout, small payload,
 *    Idempotency-Key = action id, response body discarded.
 */

export class WebhookError extends Error {}

export const WebhookInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).default(""),
  url: z.string().trim().min(10).max(1000),
});

export const WebhookFieldsSchema = z
  .record(z.string().regex(/^[A-Za-z][\w-]{0,39}$/, "field names: letters, digits, _ or -"), z.string().max(2000))
  .refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= 10, "1 to 10 fields")
  .refine((f) => JSON.stringify(f).length <= 4000, "payload too large (max 4 KB)");

export interface WebhookRow {
  id: string;
  name: string;
  description: string;
  url_ciphertext: string;
  url_fingerprint: string;
  host: string;
  created_at: string;
  last_called_at: string | null;
  last_status: string | null;
}

export function fingerprint(url: string) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function slug(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

export function getWebhook(ctx: Ctx, id: string): WebhookRow {
  const row = one<WebhookRow>(ctx.db, "SELECT * FROM webhooks WHERE id = ?", id);
  if (!row) throw new WebhookError("Unknown webhook");
  return row;
}

/** Safe view for the UI and agents: no URL, no ciphertext. */
export function listWebhooks(ctx: Ctx) {
  return all<Omit<WebhookRow, "url_ciphertext">>(ctx.db, "SELECT id, name, description, url_fingerprint, host, created_at, last_called_at, last_status FROM webhooks ORDER BY created_at");
}

export function addWebhook(ctx: Ctx, input: z.input<typeof WebhookInputSchema>) {
  assertRealAccountsAllowed("Adding a webhook");
  const { name, description, url } = WebhookInputSchema.parse(input);
  const parsed = validateFeedUrl(url);
  const clean = parsed.toString();
  const base = slug(name);
  if (!base) throw new WebhookError("Use a name with letters or digits");
  if (all(ctx.db, "SELECT id FROM webhooks").length >= 20) throw new WebhookError("Up to 20 webhooks");
  let id = `hook-${base}`;
  for (let i = 2; one(ctx.db, "SELECT id FROM services WHERE id = ?", id); i++) id = `hook-${base}-${i}`;
  tx(ctx.db, () => {
    run(
      ctx.db,
      "INSERT INTO webhooks (id, name, description, url_ciphertext, url_fingerprint, host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      name,
      description,
      seal(clean, id),
      fingerprint(clean),
      parsed.hostname,
      ctx.now().toISOString(),
    );
    // Each webhook is a service: connected, but None until the user grants it.
    run(
      ctx.db,
      `INSERT INTO services (id, name, description, kind, connection_state, access_level, max_level, scopes, last_sync_at)
       VALUES (?, ?, ?, 'real', 'connected', 'none', 'write_with_approval', ?, NULL)`,
      id,
      `Webhook: ${name}`,
      description || `Sends approved JSON to ${parsed.hostname}`,
      JSON.stringify(["POST JSON · approved actions only"]),
    );
  });
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: id, outcome: "info", summary: `Added webhook "${name}" (${parsed.hostname}). Access stays None until granted.` });
  return id;
}

export function removeWebhook(ctx: Ctx, id: string) {
  const hook = getWebhook(ctx, id);
  tx(ctx.db, () => {
    // Pending proposals for this webhook can never run now.
    run(ctx.db, "UPDATE actions SET status = 'cancelled', updated_at = ? WHERE service_id = ? AND status IN ('proposed','approved')", ctx.now().toISOString(), id);
    run(ctx.db, "DELETE FROM agent_permissions WHERE service_id = ?", id);
    run(ctx.db, "DELETE FROM services WHERE id = ?", id);
    run(ctx.db, "DELETE FROM webhooks WHERE id = ?", id);
  });
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: id, outcome: "info", summary: `Removed webhook "${hook.name}"; pending proposals cancelled` });
}

/** The destination string bound into the approval hash: webhook id + URL fingerprint. */
export function webhookDestination(ctx: Ctx, hookId: string) {
  const hook = getWebhook(ctx, hookId);
  return `webhook:${hook.id}#${hook.url_fingerprint}`;
}

export type WebhookFetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

const defaultFetcher: WebhookFetcher = async (url, init) => {
  const res = await undiciFetch(url, { ...init, dispatcher: safeAgent, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  // Read (and discard) at most a little of the body so the connection is released.
  try {
    const reader = res.body?.getReader();
    let read = 0;
    while (reader && read < 65_536) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.byteLength;
    }
    await reader?.cancel();
  } catch {
    // ignore
  }
  return { status: res.status };
};

/** Performs one approved webhook call. Throws on any mismatch or non-2xx response. */
export async function callWebhook(
  ctx: Ctx,
  action: { id: string; destination: string; payload: string; approved_at: string | null },
  fetcher: WebhookFetcher = defaultFetcher,
): Promise<string> {
  const payload = JSON.parse(action.payload) as { hookId: string; fields: Record<string, string> };
  const hook = getWebhook(ctx, payload.hookId);
  if (action.destination !== `webhook:${hook.id}#${hook.url_fingerprint}`) {
    throw new WebhookError("The webhook URL changed after approval; review and approve the action again.");
  }
  const url = open(hook.url_ciphertext, hook.id);
  validateFeedUrl(url);
  const body = JSON.stringify({ ...payload.fields, _meta: { source: "agent-command-center", actionId: action.id, approvedAt: action.approved_at } });
  let status: number;
  try {
    ({ status } = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": action.id, "user-agent": "agent-command-center/0.1" },
      body,
    }));
  } catch (err) {
    run(ctx.db, "UPDATE webhooks SET last_called_at = ?, last_status = ? WHERE id = ?", ctx.now().toISOString(), "network error", hook.id);
    throw new WebhookError(`Webhook "${hook.name}" could not be reached (${err instanceof Error ? err.message.slice(0, 80) : "error"})`);
  }
  run(ctx.db, "UPDATE webhooks SET last_called_at = ?, last_status = ? WHERE id = ?", ctx.now().toISOString(), `HTTP ${status}`, hook.id);
  if (status < 200 || status >= 300) throw new WebhookError(`Webhook "${hook.name}" answered HTTP ${status}${status >= 300 && status < 400 ? " (redirects are not followed)" : ""}`);
  return `Webhook "${hook.name}" called (${hook.host}, HTTP ${status})`;
}
