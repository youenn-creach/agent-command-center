import "./_env.mts";
import { downloadNanoModel, modelCacheDir, NANO_DTYPE, NANO_MODEL_ID, NANO_REVISION, nanoModelInstalled, verifyNanoModel } from "@/server/retrieval/embeddings";

/**
 * Explicit, one-time download of voyage-4-nano (Apache-2.0 open weights) from Hugging Face, pinned
 * to one commit and checked file by file against SHA-256. The app itself never downloads models at
 * runtime. Run again to re-check an existing install.
 */
if (nanoModelInstalled()) {
  const check = await verifyNanoModel(true);
  if (check.ok) {
    console.log(`voyage-4-nano is installed in ${modelCacheDir()} and matches the pinned files (revision ${NANO_REVISION.slice(0, 8)}).`);
    process.exit(0);
  }
  console.error(`voyage-4-nano in ${modelCacheDir()} failed its integrity check: ${check.problems.join("; ")}.`);
  console.error(`Delete ${modelCacheDir()}/${NANO_MODEL_ID} and run this command again.`);
  process.exit(1);
}
console.log(`Downloading ${NANO_MODEL_ID} (${NANO_DTYPE}, about 420 MB, revision ${NANO_REVISION.slice(0, 8)}) into ${modelCacheDir()} …`);
console.log("This happens once. After that, local semantic search runs fully offline on your CPU.");
const start = Date.now();
await downloadNanoModel();
console.log(`Done in ${Math.round((Date.now() - start) / 1000)} s. Integrity checked. Open the dashboard → Under the hood → "Index locally".`);
