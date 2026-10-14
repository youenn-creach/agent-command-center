import "./_env.mts";
import { openDb } from "@/server/db";
import { resetDemo } from "@/server/seed/seed";
import { assertDemoResetAllowed } from "@/server/mode";

try {
  assertDemoResetAllowed();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const ctx = { db: openDb(), now: () => new Date() };
const out = resetDemo(ctx);
console.log(`Demo data reset. ${out.documents} documents in the knowledge base (your own documents were kept).`);
