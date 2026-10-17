import { z } from "zod";
import { handler, readJson } from "@/server/http";
import { approveAction, cancelAction, dismissAction, editAction, executeAction } from "@/server/approvals";
import { undoDone } from "@/server/autopilot";
import { GoogleError } from "@/server/connectors/google";
import { UserError } from "@/server/errors";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("edit"), id: z.string().max(64), payload: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("approve"), id: z.string().max(64), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ op: z.literal("execute"), id: z.string().max(64) }),
  z.object({ op: z.literal("dismiss"), id: z.string().max(64) }),
  z.object({ op: z.literal("cancel"), id: z.string().max(64) }),
  // Undo of something autopilot did (or a reminder the assistant added).
  z.object({ op: z.literal("undo"), type: z.enum(["action", "reminder"]), id: z.string().max(64) }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  switch (body.op) {
    case "edit":
      return editAction(ctx, body.id, body.payload);
    case "approve":
      // The approver is the local dashboard user; there is exactly one in this single-user build.
      return approveAction(ctx, body.id, body.expectedHash, "user (local dashboard)");
    case "execute":
      return await executeAction(ctx, body.id);
    case "dismiss":
      return dismissAction(ctx, body.id);
    case "cancel":
      return cancelAction(ctx, body.id);
    case "undo":
      try {
        return await undoDone(ctx, body.type, body.id);
      } catch (err) {
        if (err instanceof GoogleError) throw new UserError(`Undo didn't go through: ${err.message}. Nothing else was changed.`, 502);
        throw err;
      }
  }
});
