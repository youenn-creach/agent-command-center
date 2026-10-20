import { getSetting, setSetting, type Ctx } from "./db";
import { seal, open } from "./connectors/secretBox";
import { appMode } from "./mode";
import { logActivity } from "./activity";
import type { LlmProvider } from "./llm";
import { requestSignal } from "./requestScope";

/**
 * Optional Mistral cloud models (owner's choice), off by default, never in the demo instance, FREE ONLY: meant for a key from
 * Mistral's free Experiment plan (no card on file means nothing can be billed). One key, one daily cap and one pause serve two
 * separate switches:
 *  - "understand requests" (2026-10-15): Mistral's API chooses the skill for a typed request. Only the request wording and the
 *    skill list are sent.
 *  - "do the work" (2026-10-20, "when I need more thinking power"): drafts, answers, briefings and reviews are written by a
 *    Mistral cloud model. The text a task needs (emails, notes, calendar entries) IS sent to Mistral then. The local model takes
 *    over for any call Mistral refuses, and for everything once the day's cap is reached or Mistral pauses it.
 * On a rate-limit, quota, payment or key error the app pauses cloud use until the next day. The key is sealed (AES-GCM,
 * secretBox) and never returned by any API.
 */

const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
export const CLOUD_MODELS = ["mistral-small-latest", "ministral-8b-latest", "mistral-medium-latest"] as const;
export type CloudModel = (typeof CLOUD_MODELS)[number];
/** Models for doing the work: bigger ones are the point ("more thinking power"); all are on the free Experiment plan. */
export const CLOUD_WORK_MODELS = ["mistral-medium-latest", "mistral-large-latest", "mistral-small-latest"] as const;
export type CloudWorkModel = (typeof CLOUD_WORK_MODELS)[number];
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
  /** "Do the work in the cloud": on or off, and with which model. */
  work: { enabled: boolean; model: CloudWorkModel };
}

const today = (ctx: Ctx) => ctx.now().toISOString().slice(0, 10);
const usedOn = (ctx: Ctx, day: string) => (getSetting(ctx.db, "cloud.router.day") === day ? Number(getSetting(ctx.db, "cloud.router.count") ?? 0) : 0);

export function cloudRouterStatus(ctx: Ctx): CloudRouterStatus {
  const enabled = getSetting(ctx.db, "cloud.router.enabled") === "on";
  const hasKey = Boolean(getSetting(ctx.db, "cloud.router.key"));
  const model = (CLOUD_MODELS as readonly string[]).includes(getSetting(ctx.db, "cloud.router.model") ?? "") ? (getSetting(ctx.db, "cloud.router.model") as CloudModel) : "mistral-small-latest";
  const usedToday = usedOn(ctx, today(ctx));
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
  const workModel = getSetting(ctx.db, "cloud.work.model") ?? "";
  const work = {
    enabled: getSetting(ctx.db, "cloud.work.enabled") === "on",
    model: ((CLOUD_WORK_MODELS as readonly string[]).includes(workModel) ? workModel : "mistral-medium-latest") as CloudWorkModel,
  };
  return { enabled, hasKey, model, usedToday, cap, blocked, work };
}

/** Saves the switches, the models and the key (sealed). An empty key removes it, and turns both switches off. */
export function setCloudRouter(ctx: Ctx, input: { enabled?: boolean; key?: string; model?: CloudModel; work?: boolean; workModel?: CloudWorkModel }) {
  if (input.key !== undefined) {
    setSetting(ctx.db, "cloud.router.key", input.key ? seal(input.key.trim(), KEY_CONTEXT) : "");
    setSetting(ctx.db, "cloud.router.paused", "");
    if (!input.key) {
      setSetting(ctx.db, "cloud.router.enabled", "off");
      setSetting(ctx.db, "cloud.work.enabled", "off");
    }
  }
  if (input.model) setSetting(ctx.db, "cloud.router.model", input.model);
  if (input.enabled !== undefined) setSetting(ctx.db, "cloud.router.enabled", input.enabled ? "on" : "off");
  if (input.workModel) setSetting(ctx.db, "cloud.work.model", input.workModel);
  if (input.work !== undefined) setSetting(ctx.db, "cloud.work.enabled", input.work ? "on" : "off");
  const parts = [
    input.enabled !== undefined ? `understanding requests ${input.enabled ? "on (only the request wording is sent)" : "off"}` : null,
    input.work !== undefined ? `doing the work ${input.work ? "on (the text each task needs, emails included, is sent to Mistral)" : "off (the local model does the work)"}` : null,
    input.model ? `model for understanding: ${input.model}` : null,
    input.workModel ? `model for the work: ${input.workModel}` : null,
    input.key !== undefined ? (input.key ? "API key saved" : "API key removed") : null,
  ].filter(Boolean);
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: `Mistral cloud: ${parts.join(", ") || "settings changed"}` });
  return cloudRouterStatus(ctx);
}

function pause(ctx: Ctx, why: string) {
  setSetting(ctx.db, "cloud.router.paused", today(ctx));
  setSetting(ctx.db, "cloud.router.pausedWhy", why);
  logActivity(ctx, { actor: "chief_of_staff", kind: "system", outcome: "info", summary: `Mistral cloud paused until tomorrow: ${why}. The local model is used.` });
}

/** One Mistral model behind the shared key, cap and pause. Every call counts against the day's cap and re-checks it. */
function mistralProvider(ctx: Ctx, model: string, limits: { maxTokens: number; timeoutMs: number }, fetcher: typeof fetch): LlmProvider | null {
  const sealed = getSetting(ctx.db, "cloud.router.key");
  let key: string;
  try {
    key = open(sealed!, KEY_CONTEXT);
  } catch {
    return null;
  }
  return {
    id: "mistral-api",
    label: `Mistral API (${model}, cloud)`,
    model,
    async generate(system, user, opts = {}) {
      const t = Date.now();
      // A provider can serve many calls (an inbox review makes about ten): the cap and the pause are checked on each one.
      const status = cloudRouterStatus(ctx);
      if (status.blocked) throw new Error(`Mistral cloud not used: ${status.blocked}`);
      const day = today(ctx);
      setSetting(ctx.db, "cloud.router.day", day);
      setSetting(ctx.db, "cloud.router.count", String(usedOn(ctx, day) + 1));
      let res: Response;
      try {
        res = await fetcher(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: opts.temperature ?? 0,
            max_tokens: Math.min(opts.maxTokens ?? 300, limits.maxTokens),
            ...(opts.format ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: opts.format, strict: true } } } : {}),
          }),
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(Math.min(opts.timeoutMs ?? limits.timeoutMs, limits.timeoutMs)), ...[opts.signal, requestSignal()].filter((x): x is AbortSignal => !!x)]),
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
      return { text, model: `mistral-api:${model}`, ms: Date.now() - t };
    },
  };
}

/** The Mistral API for understanding requests, or null when it must not be used (both switches off, no key, demo, paused, limit). */
export function cloudRouter(ctx: Ctx, fetcher: typeof fetch = fetch): LlmProvider | null {
  const status = cloudRouterStatus(ctx);
  // Doing the work in the cloud includes understanding the request (it would be odd to send the emails but not the wording).
  if (!(status.enabled || status.work.enabled) || status.blocked) return null;
  return mistralProvider(ctx, status.work.enabled && !status.enabled ? status.work.model : status.model, { maxTokens: 400, timeoutMs: 30_000 }, fetcher);
}

/**
 * The Mistral API for doing the work (drafts, answers, briefings, reviews), or null when "do the work in the cloud" is off or
 * can't be used now. Callers wrap it with the local model as the fallback (llm.ts: workLlm).
 */
export function cloudWorker(ctx: Ctx, fetcher: typeof fetch = fetch): LlmProvider | null {
  const status = cloudRouterStatus(ctx);
  if (!status.work.enabled || status.blocked) return null;
  return mistralProvider(ctx, status.work.model, { maxTokens: 2000, timeoutMs: 120_000 }, fetcher);
}
