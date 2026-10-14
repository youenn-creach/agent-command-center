import { z } from "zod";
import { handler, readJson } from "@/server/http";
import { AccessLevelSchema } from "@/server/policy/levels";
import { disconnectService, reconnectDemoService, setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { disconnectGoogle, isGoogleService } from "@/server/connectors/google";

const Id = z.string().min(1).max(64);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("service"), serviceId: Id, level: AccessLevelSchema }),
  z.object({ op: z.literal("agent"), agentId: Id, serviceId: Id, level: AccessLevelSchema }),
  z.object({ op: z.literal("disconnect"), serviceId: Id }),
  z.object({ op: z.literal("reconnect"), serviceId: Id }),
]);

export const POST = handler(true, async (req, ctx) => {
  const body = Body.parse(await readJson(req));
  if (body.op === "service") setServiceLevel(ctx, body.serviceId, body.level);
  else if (body.op === "agent") setAgentLevel(ctx, body.agentId, body.serviceId, body.level);
  else if (body.op === "disconnect") {
    // Real services: revoke at the provider and delete the token and synced data, not just flip a flag.
    if (isGoogleService(body.serviceId)) await disconnectGoogle(ctx, body.serviceId);
    else disconnectService(ctx, body.serviceId);
  }
  else reconnectDemoService(ctx, body.serviceId);
  return { ok: true };
});
