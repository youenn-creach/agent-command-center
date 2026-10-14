/**
 * Runs the email review on a real mailbox and prints what the subject scan picked and every verdict
 * (never shown in the app). For checking quality with the owner's permission:
 *   LIVE_DB=$PWD/data/acc.sqlite npx tsx scripts/review-diagnose.mts
 *   LIVE_DB=$PWD/data/acc.sqlite npx tsx scripts/review-diagnose.mts peek "<subject regex>"   (opening text of matching emails, printed locally)
 *   LIVE_DB=$PWD/data/acc.sqlite npx tsx scripts/review-diagnose.mts event "<request>"   (route it with the model, then find the event in the mail; nothing is proposed)
 * Read-only: Gmail is only searched and read; nothing is stored or sent.
 */
import "./_env.mts";
import { openDb } from "@/server/db";
import { reviewInbox } from "@/server/agents/inboxReview";
import { findEventInEmail, routeRequest } from "@/server/agents/assistant";
import { readGmailById, searchGmail } from "@/server/connectors/google";
const ctx = { db: openDb(process.env.LIVE_DB), now: () => new Date() };
if (process.argv[2] === "peek") {
  // Opening text of the emails whose verdict we want to judge by hand (printed locally only).
  const rows = await searchGmail(ctx, "in:inbox newer_than:7d", 50);
  const pattern = new RegExp(process.argv[3] ?? "^$", "i");
  for (const r of rows.filter((x) => pattern.test(x.subject))) {
    const m = await readGmailById(ctx, r.id);
    console.log(`\n### ${r.subject}\n${m.text.replace(/\s+/g, " ").slice(0, 600)}`);
  }
} else if (process.argv[2] === "event") {
  const text = process.argv[3] ?? "";
  const route = await routeRequest(ctx, text);
  console.log("route:", JSON.stringify({ skill: route.skill, args: route.args, s: Math.round(route.ms / 1000) }));
  const out = await findEventInEmail(ctx, text, route.args.query ?? "", (p) => console.log("..", p));
  console.log(JSON.stringify(out, (k, v) => (k === "ics" || k === "googleUrl" ? undefined : v), 1));
} else {
  const out = await reviewInbox(ctx, 7, (p) => console.log("..", p));
  console.log(JSON.stringify(out.trace, null, 1));
  console.log(out.reply);
}
process.exit(0);
