import "./_env.mts";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "@/server/db";
import { resetDemo } from "@/server/seed/seed";
import { setNotifyDeps } from "@/server/notify";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { listRequests } from "@/server/requests";
import { setServiceLevel, setAgentLevel } from "@/server/policy/permissions";
import { listActions } from "@/server/approvals";

/**
 * A scripted session of Ctrl+K requests through the real app code and the real local model, on a throwaway
 * folder with the fictional demo data: wording as a person would type it, with typos, vague asks, two asks
 * in one, and things it can't do. Records what each request answered, how long it took, and what it left
 * waiting for approval. Run: ACC_MODE=mixed ACC_DATA_DIR=.e2e-data/sim npx tsx scripts/simulate-session.mts [first-last]
 */
process.env.ACC_MODE ??= "mixed";
setNotifyDeps({ desktop: async () => {}, push: async () => 200 });
// SIM_SET=real runs the second batch on a COPY of the real database (made by the caller into ACC_DATA_DIR):
// real mail and calendar are only read; everything written (reminders, proposals) stays in the copy.
const real = process.env.SIM_SET === "real";
const ctx = { db: openDb(path.join(process.env.ACC_DATA_DIR ?? "data", "acc.sqlite")), now: () => new Date() };
if (!real) resetDemo(ctx);
setServiceLevel(ctx, "web-search", "read");
setAgentLevel(ctx, "knowledge", "web-search", "read");

const DEMO_REQUESTS = [
  "what's on my calendar today?",
  "whats on tmrw",
  "am i free thursday afternoon",
  "add event: dentist friday 3pm at Riverside Dental",
  "put lunch with Sam next tuesday at noon in my calendar",
  "remind me to call the plumber tomorrow at 9",
  "remind me to chase Priya on monday",
  "who hasn't gotten back to me?",
  "chase Priya about the quote",
  "chase everyone who hasn't replied",
  "what did I note about the kitchen?",
  "what's my half marathon goal?",
  "brief me",
  "do i have anything waiting for approval",
  "when does the weekly review run?",
  "remember that I prefer short replies",
  "prep me for tomorrow's meetings",
  "what's the weather like in Barcelona tomorrow?",
  "who won the champions league final in 2025?",
  "book me a table at a restaurant tonight",
  "translate good morning into german",
  "delete all my reminders",
  "pay the electricity bill",
  "that thing from Laura",
  "add dinner with Laura to my calendar and remind me the day before",
];
// Harder asks on the real mailbox copy: chains, two asks in one, vague wording, follow-ups to nothing.
const REAL_REQUESTS = [
  "from my emails, check when i registered for a race, then add it to my calendar",
  "any mail from the last two weeks that I should look at?",
  "did anyone write to me about a booking?",
  "what's my next flight and what will the weather be like there?",
  "which subscriptions am I paying for, and which could I cancel?",
  "find the most recent receipt in my email and tell me how much it was",
  "do I have anything coming up this week, and do I need to prepare for any of it?",
  "remind me to look at my insurance emails on friday",
  "who is waiting for an answer from me and who am I waiting on?",
  "add the second one to my calendar",
  "what did I just ask you?",
  "cancel that",
  "i need to renew something soon, what is it?",
  "email Marc that I'll be late",
  "what's in my spam?",
  "wat is on my agenda next week",
  "quand est mon prochain vol ?",
  "summarize everything that happened in my inbox today, then draft replies to anything urgent",
];
const REQUESTS = real ? REAL_REQUESTS : DEMO_REQUESTS;

const range = process.argv[2]?.match(/^(\d+)-(\d+)$/);
const picked = REQUESTS.map((text, i) => ({ text, n: i + 1 })).filter((r) => !range || (r.n >= +range[1] && r.n <= +range[2]));

const queue = () => (globalThis as { __accBackground?: { tail: Promise<void> } }).__accBackground?.tail ?? Promise.resolve();
const rows: Record<string, unknown>[] = [];
for (const { text, n } of picked) {
  const t = Date.now();
  const before = new Set(listActions(ctx).map((a) => a.id));
  let direct;
  try {
    direct = await runCommand(ctx, text, workflows);
  } catch (err) {
    direct = { intent: "ERROR", reply: String(err) } as never;
  }
  const askedMs = Date.now() - t;
  await queue();
  const board = listRequests(ctx).find((r) => r.text === text);
  const answer = (board?.answer?.reply ?? direct.reply).replace(/\s+/g, " ");
  const proposed = listActions(ctx).filter((a) => !before.has(a.id)).map((a) => a.title);
  const row = { n, text, intent: direct.intent, understood: (direct as { understood?: string }).understood ?? "", askedMs, totalMs: Date.now() - t, state: board?.state, status: board?.status, answer: answer.slice(0, 400), items: (board?.answer?.items ?? direct.items ?? []).length, proposed };
  rows.push(row);
  console.log(`#${n} [${row.intent}] ${Math.round(row.askedMs / 1000)}s+${Math.round((row.totalMs - row.askedMs) / 1000)}s ${row.state ?? ""} | ${text}\n   → ${answer.slice(0, 300)}${proposed.length ? `\n   ⏳ waiting for approval: ${proposed.join(" | ")}` : ""}`);
}
writeFileSync(path.join(process.env.ACC_DATA_DIR ?? "data", `simulation-${range ? range[0] : "all"}.json`), JSON.stringify(rows, null, 2));
process.exit(0);
