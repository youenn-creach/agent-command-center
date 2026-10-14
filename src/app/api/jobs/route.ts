import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/http";
import { createJob, deleteJob, pauseJob, previewSchedule, resumeJob, SchedulerError, startRunNow, updateJob, UpdateJobSchema } from "@/server/scheduler/scheduler";
import { catalogEntry } from "@/server/agents/catalog";
import { workflows } from "@/server/agents/chiefOfStaff";

const Id = z.string().min(1).max(64);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pause"), id: Id }),
  z.object({ op: z.literal("resume"), id: Id }),
  z.object({ op: z.literal("run"), id: Id }),
  z.object({ op: z.literal("edit"), id: Id, patch: UpdateJobSchema }),
  z.object({ op: z.literal("delete"), id: Id }),
  z.object({ op: z.literal("preview"), cron: z.string().min(1).max(100), timezone: z.string().min(1).max(64) }),
  z.object({ op: z.literal("create"), workflow: z.string().max(64), name: z.string().trim().min(1).max(120), cron: z.string().min(1).max(100), timezone: z.string().min(1).max(64) }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  switch (body.op) {
    case "pause":
      return pauseJob(ctx, body.id);
    case "resume":
      return resumeJob(ctx, body.id);
    case "edit":
      return updateJob(ctx, body.id, body.patch);
    case "delete":
      deleteJob(ctx, body.id);
      return { ok: true };
    case "preview":
      return { next: previewSchedule(body.cron, body.timezone, ctx.now()) };
    case "create": {
      // Requirements come from the catalog, never from the request: a new schedule cannot widen access.
      const entry = catalogEntry(body.workflow);
      if (!entry) throw new SchedulerError("Unknown workflow");
      previewSchedule(body.cron, body.timezone, ctx.now());
      const job = createJob(ctx, {
        name: body.name,
        purpose: entry.description,
        agentId: entry.agentId,
        workflow: entry.workflow,
        cron: body.cron,
        timezone: body.timezone,
        sources: entry.sources,
        destination: entry.destination,
        requirements: entry.requirements,
        createdBy: "user",
      });
      return job;
    }
    case "run":
      rateLimit("run-now", 6);
      return startRunNow(ctx, body.id, workflows);
  }
});
