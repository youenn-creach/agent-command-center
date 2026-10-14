import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/http";
import { CommandSchema, runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { warmRouter } from "@/server/agents/assistant";
import { activeLlmCalls } from "@/server/llmRuntime";

const Warm = z.object({ op: z.literal("warm") });

export const POST = handler(true, async (req, ctx) => {
  const body = await readJson(req);
  // Opening the command bar warms the local model up, so the request that follows is understood faster.
  if (Warm.safeParse(body).success) return warmRouter(ctx, activeLlmCalls(ctx).length > 0);
  rateLimit("command", 20);
  const { text } = CommandSchema.parse(body);
  return runCommand(ctx, text, workflows);
});
