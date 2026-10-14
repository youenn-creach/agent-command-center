import { handler } from "@/server/http";
import { dashboardState } from "@/server/state";

export const GET = handler(false, async (_req, ctx) => dashboardState(ctx));
