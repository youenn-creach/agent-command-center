import { all, one, run, tx, type Ctx } from "./db";
import { logActivity } from "./activity";
import { removeFromAtlas } from "./retrieval/knowledge";

/** Everything that is the user's own (non-demo) data, for export. Never includes configuration or secrets. */
export function exportUserData(ctx: Ctx) {
  return {
    exportedAt: ctx.now().toISOString(),
    documents: all(ctx.db, "SELECT id, title, source_type, source_ref, tags, content, created_at, atlas_share, atlas_synced_at FROM documents WHERE is_demo = 0"),
    actions: all(ctx.db, "SELECT id, agent_id, service_id, kind, title, destination, payload, status, approved_by, approved_at, executed_at, result, created_at FROM actions"),
    activity: all(ctx.db, "SELECT ts, actor, kind, agent_id, service_id, summary, outcome FROM activity ORDER BY id"),
    aboutMe: all(ctx.db, "SELECT text, created_at, updated_at FROM memory_facts ORDER BY created_at"),
    requests: all(ctx.db, "SELECT text, intent, reply, created_at FROM requests ORDER BY created_at"),
    corrections: all(ctx.db, "SELECT text, wrong, chosen, created_at FROM route_corrections ORDER BY created_at"),
    reminders: all(ctx.db, "SELECT text, due_at, done_at, source, created_at FROM reminders ORDER BY created_at"),
  };
}

/**
 * Deletes user-added documents (and their local vectors), About me facts, request and search history, corrections,
 * and the activity log. Notes shared to Atlas are removed there first; if that fails, nothing is cleared.
 */
export async function clearUserData(ctx: Ctx) {
  if (one(ctx.db, "SELECT 1 FROM documents WHERE is_demo = 0 AND atlas_synced_at IS NOT NULL LIMIT 1")) await removeFromAtlas(ctx);
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM documents WHERE is_demo = 0");
    run(ctx.db, "DELETE FROM retrieval_runs");
    run(ctx.db, "DELETE FROM activity");
    run(ctx.db, "DELETE FROM requests");
    run(ctx.db, "DELETE FROM route_corrections");
    run(ctx.db, "DELETE FROM memory_facts");
  });
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: "Cleared user-added documents, About me, request history, search history and activity log" });
}
