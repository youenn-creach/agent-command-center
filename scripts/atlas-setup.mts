import "./_env.mts";
import { config } from "@/server/config";
import { ATLAS_COLLECTION, ATLAS_INDEX, ATLAS_TEXT_INDEX, atlasStatus, ensureTextIndex, ensureVectorIndex, safeError } from "@/server/retrieval/atlas";

/**
 * Creates (or updates) the Atlas search indexes for the knowledge chunks. Run once after setting
 * ATLAS_ENABLED / MONGODB_URI, and again after an update that adds a filter field. Uses only operations available on the free M0 tier;
 * it never creates clusters or changes tiers.
 */
const c = config();
if (!c.ATLAS_ENABLED) {
  console.error("ATLAS_ENABLED is not true in .env.local — nothing to do.");
  process.exit(1);
}
try {
  const before = await atlasStatus();
  if (!before.reachable) throw new Error(before.error ?? "Atlas not reachable");
  console.log(`Connected. Database "${c.ATLAS_DB_NAME}", collection "${ATLAS_COLLECTION}": ${before.chunkCount} documents, ${before.searchIndexCount} search index(es) on this collection.`);
  console.log("Note: M0 free clusters allow a small number of Search/Vector Search indexes in total (3 at the time of writing). Check your other projects' indexes if creation fails.");
  const res = await ensureVectorIndex(c.VOYAGE_DIMENSIONS);
  console.log(
    res.created
      ? `Created vector index "${ATLAS_INDEX}" (${c.VOYAGE_DIMENSIONS} dims, dotProduct, filters: space, sourceType, tags, isDemo, origin). It takes a minute to become queryable.`
      : res.updated
        ? `Updated vector index "${ATLAS_INDEX}" with the origin filter (for shared notes). Atlas rebuilds it in about a minute.`
        : `Vector index "${ATLAS_INDEX}" already exists.`,
  );
  const text = await ensureTextIndex();
  console.log(text.created ? `Created full-text index "${ATLAS_TEXT_INDEX}" (for the hybrid $rankFusion mode).` : text.updated ? `Updated full-text index "${ATLAS_TEXT_INDEX}" with the origin field.` : `Full-text index "${ATLAS_TEXT_INDEX}" already exists.`);
  process.exit(0);
} catch (err) {
  console.error(`Atlas setup failed: ${safeError(err)}`);
  process.exit(1);
}
