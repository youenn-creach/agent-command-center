import { getSetting, setSetting, type Ctx } from "./db";
import { seal, open } from "./connectors/secretBox";
import { appMode } from "./mode";
import { logActivity } from "./activity";
import type { LlmProvider } from "./llm";

/**
 * Optional cloud help for UNDERSTANDING requests only (owner's choice, 2026-10-15): Mistral's own API chooses the skill for a
 * typed request. Only the request wording and the skill list leave the machine; mail, notes, calendar, drafts and answers stay
 * local (the self-check stays local too). Off by default. FREE ONLY: meant for a key from Mistral's free Experiment plan (no card
 * on file means nothing can be billed); the app caps itself per day and, on a rate-limit, quota, payment or key error, falls back
 * to the local model and pauses cloud use until the next day. Never in the demo instance. The key is sealed (AES-GCM, secretBox)
 * and never returned by any API.
 */

const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
export const CLOUD_MODELS = ["mistral-small-latest", "ministral-8b-latest", "mistral-medium-latest"] as const;
export type CloudModel = (typeof CLOUD_MODELS)[number];
const DEFAULT_CAP = 200;
const KEY_CONTEXT = "mistral-api-key";

export interface CloudRouterStatus {
  enabled: boolean;
  hasKey: boolean;
  model: CloudModel;
  usedToday: number;
  cap: number;
  /** Why it is not used right now, if it isn't (paused after an error, cap reached, demo instance, no key). */
  blocked: string | null;
}

const today = (ctx: Ctx) => ctx.now().toISOString().slice(0, 10);

export function cloudRouterStatus(ctx: Ctx): CloudRouterStatus {
  const enabled = getSetting(ctx.db, "cloud.router.enabled") === "on";
  const hasKey = Boolean(getSetting(ctx.db, "cloud.router.key"));
  const model = (CLOUD_MODELS as readonly string[]).includes(getSetting(ctx.db, "cloud.router.model") ?? "") ? (getSetting(ctx.db, "cloud.router.model") as CloudModel) : "mistral-small-latest";
  const usedToday = getSetting(ctx.db, "cloud.router.day") === today(ctx) ? Number(getSetting(ctx.db, "cloud.router.count") ?? 0) : 0;
  const cap = Number(getSetting(ctx.db, "cloud.router.cap") ?? DEFAULT_CAP) || DEFAULT_CAP;
  const pausedDay = getSetting(ctx.db, "cloud.router.paused");
  const blocked =
    appMode() === "demo"
      ? "not available in the demo"
      : !hasKey
        ? "no API key saved"
        : pausedDay === today(ctx)
          ? `paused until tomorrow (${getSetting(ctx.db, "cloud.router.pausedWhy") ?? "an error from Mistral"})`
          : usedToday >= cap
            ? `today's limit of ${cap} requests is reached`
            : null;
  return { enabled, hasKey, model, usedToday, cap, blocked };
}

/** Saves the toggle, the model and the key (sealed). An empty key removes it. */
export function setCloudRouter(ctx: Ctx, input: { enabled?: boolean; key?: string; model?: CloudModel }) {
  if (input.key !== undefined) {
    setSetting(ctx.db, "cloud.router.key", input.key ? seal(input.key.trim(), KEY_CONTEXT) : "");
    setSetting(ctx.db, "cloud.router.paused", "");
  }
  if (input.model) setSetting(ctx.db, "cloud.router.model", input.model);
  if (input.enabled !== undefined) setSetting(ctx.db, "cloud.router.enabled", input.enabled ? "on" : "off");
  logActivity(ctx, {
    actor: "user",
    kind: "system",
    outcome: "info",
    summary: `Cloud help for understanding requests: ${input.enabled === undefined ? "settings changed" : input.enabled ? "on (Mistral API; only the request wording is sent)" : "off"}${input.key !== undefined ? (input.key ? ", API key saved" : ", API key removed") : ""}`,
  });
  return cloudRouterStatus(ctx);
}

function pause(ctx: Ctx, why: string) {
  setSetting(ctx.db, "cloud.router.paused", today(ctx));
  setSetting(ctx.db, "cloud.router.pausedWhy", why);
  logActivity(ctx, { actor: "chief_of_staff", kind: "system", outcome: "info", summary: `Cloud help for understanding requests paused until tomorrow: ${why}. The local model is used.` });
}

/** The Mistral API as a provider for the router, or null when it must not be used (off, no key, demo, paused, limit reached). */
export function cloudRouter(ctx: Ctx, fetcher: typeof fetch = fetch): LlmProvider | null {
  const status = cloudRouterStatus(ctx);
  if (!status.enabled || status.blocked) return null;
  const sealed = getSetting(ctx.db, "cloud.router.key");
  let key: string;
  try {
    key = open(sealed!, KEY_CONTEXT);
  } catch {
    return null;
  }
  return {
    id: "mistral-api",
    label: `Mistral API (${status.model}, cloud)`,
    model: status.model,
    async generate(system, user, opts = {}) {
      const t = Date.now();
      const day = today(ctx);
      const used = getSetting(ctx.db, "cloud.router.day") === day ? Number(getSetting(ctx.db, "cloud.router.count") ?? 0) : 0;
      setSetting(ctx.db, "cloud.router.day", day);
      setSetting(ctx.db, "cloud.router.count", String(used + 1));
      let res: Response;
      try {
        res = await fetcher(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: status.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: opts.temperature ?? 0,
            max_tokens: Math.min(opts.maxTokens ?? 200, 400),
            ...(opts.format ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: opts.format, strict: true } } } : {}),
          }),
          signal: AbortSignal.timeout(Math.min(opts.timeoutMs ?? 30_000, 30_000)),
        });
      } catch (err) {
        throw new Error(`Mistral API unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        // Rate limit, quota, payment or key problems: never retry, never escalate; pause and use the local model.
        if ([401, 402, 403, 429].includes(res.status)) pause(ctx, res.status === 429 ? "rate limit or free-tier quota reached" : res.status === 402 ? "the account would need payment" : "the API key was refused");
        throw new Error(`Mistral API answered ${res.status}`);
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("Mistral API gave an empty answer");
      return { text, model: `mistral-api:${status.model}`, ms: Date.now() - t };
    },
  };
}
