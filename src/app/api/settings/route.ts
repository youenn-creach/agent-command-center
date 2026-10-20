import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/http";
import { LLM_TASKS, selectModel, setLanguageModel, speedTest } from "@/server/llm";
import { LANG_NAMES } from "@/server/lang";
import { logActivity } from "@/server/activity";
import { setSetting } from "@/server/db";
import { offloadModels } from "@/server/llmRuntime";
import { notify, NotifyError, NotifySettingsInput, setNotificationSettings } from "@/server/notify";
import { FeedError } from "@/server/news/feeds";
import { setCalendarMode } from "@/server/calendarMode";
import { CLOUD_MODELS, CLOUD_WORK_MODELS, setCloudRouter } from "@/server/cloudRouter";
import { AUTO_KINDS, MAX_PER_DAY, MAX_PER_HOUR, setAutopilot } from "@/server/autopilot";
import { pruneOldData, RetentionSchema, setRetention } from "@/server/retention";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("select-model"), model: z.string().min(1).max(120).regex(/^[\w.:/-]+$/), task: z.enum(LLM_TASKS as [string, ...string[]]) }),
  z.object({ op: z.literal("speed-test"), model: z.string().min(1).max(120).regex(/^[\w.:/-]+$/).optional() }),
  z.object({ op: z.literal("retention"), value: RetentionSchema }),
  z.object({ op: z.literal("prune-now") }),
  z.object({ op: z.literal("ui-simple"), value: z.boolean() }),
  z.object({ op: z.literal("offload"), mode: z.enum(["now", "when-idle"]) }),
  z.object({ op: z.literal("notify-settings"), value: NotifySettingsInput }),
  z.object({ op: z.literal("notify-test") }),
  z.object({ op: z.literal("calendar-mode"), mode: z.enum(["app", "link"]) }),
  // Autopilot: only from this page (a click in Settings or the header switch), never from a request's words.
  z.object({ op: z.literal("autopilot"), kind: z.enum(AUTO_KINDS).optional(), enabled: z.boolean().optional(), paused: z.boolean().optional(), perHour: z.number().int().min(1).max(MAX_PER_HOUR).optional(), perDay: z.number().int().min(1).max(MAX_PER_DAY).optional() }).refine((b) => (b.kind !== undefined && b.enabled !== undefined) || b.paused !== undefined || b.perHour !== undefined || b.perDay !== undefined, "Say which kind to turn on or off, whether to pause, or the limits"),
  z.object({ op: z.literal("cloud-router"), enabled: z.boolean().optional(), key: z.string().max(200).regex(/^[\w.-]*$/).optional(), model: z.enum(CLOUD_MODELS).optional(), work: z.boolean().optional(), workModel: z.enum(CLOUD_WORK_MODELS).optional() }),
  z.object({ op: z.literal("language-model"), lang: z.enum(["en", "fr", "es", "ca"]), model: z.string().min(1).max(200).regex(/^[\w.:/-]+$/).nullable() }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  if (body.op === "select-model") {
    await selectModel(ctx, body.model, body.task as "background" | "interactive");
    logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: `Local LLM for ${body.task} tasks set to ${body.model}` });
    return { ok: true };
  }
  if (body.op === "retention") {
    setRetention(ctx, body.value);
    return { removed: pruneOldData(ctx) };
  }
  if (body.op === "prune-now") return { removed: pruneOldData(ctx) };
  if (body.op === "offload") return offloadModels(ctx, body.mode);
  if (body.op === "notify-settings") {
    try {
      setNotificationSettings(ctx, body.value);
    } catch (err) {
      if (err instanceof NotifyError || err instanceof FeedError) throw new HttpError(400, err.message);
      throw err;
    }
    return { ok: true };
  }
  if (body.op === "autopilot") return setAutopilot(ctx, { kind: body.kind, enabled: body.enabled, paused: body.paused, perHour: body.perHour, perDay: body.perDay });
  if (body.op === "cloud-router") return setCloudRouter(ctx, { enabled: body.enabled, key: body.key, model: body.model, work: body.work, workModel: body.workModel });
  if (body.op === "language-model") {
    await setLanguageModel(ctx, body.lang, body.model);
    logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: body.model ? `Reply drafts in ${LANG_NAMES[body.lang]} now use ${body.model}` : `Reply drafts in ${LANG_NAMES[body.lang]} use the background model` });
    return { ok: true };
  }
  if (body.op === "calendar-mode") {
    setCalendarMode(ctx, body.mode);
    logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: body.mode === "app" ? "Calendar events: the app creates them after your approval" : "Calendar events: you add them yourself in Google Calendar" });
    return { ok: true };
  }
  if (body.op === "notify-test") {
    rateLimit("notify-test", 4);
    const sent = await notify(ctx, { key: "test", kind: "test", title: "Agent Command Center", summary: "Test notification: notifications work." });
    if (!sent) throw new HttpError(400, "Turn on desktop notifications or add an ntfy topic first.");
    return sent;
  }
  if (body.op === "ui-simple") {
    setSetting(ctx.db, "ui.simple", body.value ? "1" : "0");
    return { ok: true };
  }
  rateLimit("speed-test", 3);
  return speedTest(ctx, body.model);
});
