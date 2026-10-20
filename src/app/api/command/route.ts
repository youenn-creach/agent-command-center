import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/http";
import { cancelRequest, ChosenSchema, CommandSchema, runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { warmRouter } from "@/server/agents/assistant";
import { activeLlmCalls } from "@/server/llmRuntime";
import { runInRequestScope } from "@/server/requestScope";

const Warm = z.object({ op: z.literal("warm") });
const Cancel = z.object({ op: z.literal("cancel"), id: z.string().min(1).max(64) });

export const POST = handler(true, async (req, ctx) => {
  const body = await readJson(req);
  // Opening the command bar warms the local model up, so the request that follows is understood faster.
  if (Warm.safeParse(body).success) return warmRouter(ctx, activeLlmCalls(ctx).length > 0);
  // "Cancel" on a request that is still working (the prompt bar or the request board).
  const cancel = Cancel.safeParse(body);
  if (cancel.success) return cancelRequest(ctx, cancel.data.id);
  rateLimit("command", 20);
  // "Not right?": the same request with the kind the user picked.
  const chosen = ChosenSchema.safeParse(body);
  // The browser's Cancel (or closing the tab) while the request is being understood aborts this request: its model call
  // stops, and nothing is run for it.
  if (chosen.success) return runInRequestScope("understanding", req.signal, () => runCommand(ctx, chosen.data.text, workflows, undefined, undefined, { skill: chosen.data.skill, wrong: chosen.data.wrong }));
  const { text } = CommandSchema.parse(body);
  return runInRequestScope("understanding", req.signal, () => runCommand(ctx, text, workflows));
});
