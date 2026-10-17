import "./_env.mts";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { openDb, setSetting } from "@/server/db";
import { resetDemo } from "@/server/seed/seed";
import { setNotifyDeps } from "@/server/notify";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { listRequests } from "@/server/requests";
import { setServiceLevel, setAgentLevel } from "@/server/policy/permissions";
import { listActions } from "@/server/approvals";
import { BATCH3 } from "./sim-batch3";
import { BATCH4 } from "./sim-batch4";
import { BATCH5 } from "./sim-batch5";
import { BATCH6 } from "./sim-batch6";
import { BATCH7 } from "./sim-batch7";
import { BATCH8 } from "./sim-batch8";
import { BATCH9 } from "./sim-batch9";
import { connectFakeGmail } from "./sim-gmail";

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
// SIM_NOW fixes the clock (e.g. 2026-10-15T08:30:00Z) so expectations written once never go stale; it moves on with real time
// from there, so "in 2 hours" and queued work still behave.
const started = Date.now();
const fixed = process.env.SIM_NOW ? Date.parse(process.env.SIM_NOW) : null;
const ctx = { db: openDb(path.join(process.env.ACC_DATA_DIR ?? "data", "acc.sqlite")), now: () => (fixed ? new Date(fixed + (Date.now() - started)) : new Date()) };
if (!real) resetDemo(ctx);
// Batch 3 mixes mail with calendar and web: it gets a fake Gmail holding the demo mails (scripts/sim-gmail.ts).
if (["batch3", "batch4", "batch5", "batch6", "batch7", "batch8", "batch9"].includes(process.env.SIM_SET ?? "")) await connectFakeGmail(ctx);
setServiceLevel(ctx, "web-search", "read");
// SIM_SELFCHECK=off measures the app without the self-check (to see what it adds).
if (process.env.SIM_SELFCHECK === "off") setSetting(ctx.db, "assistant.selfcheck", "off");
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
// SIM_SET=batch3: complex asks on the demo data, each with the expected outcome written beforehand (sim-batch3.ts).
// SIM_SET=batch4 is the held-out batch (sim-batch4.ts): run it only on a frozen commit.
const EXPECTED = { batch3: BATCH3, batch4: BATCH4, batch5: BATCH5, batch6: BATCH6, batch7: BATCH7, batch8: BATCH8, batch9: BATCH9 }[process.env.SIM_SET ?? ""] ?? null;
const REQUESTS = EXPECTED ? EXPECTED.map((b) => b.text) : real ? REAL_REQUESTS : DEMO_REQUESTS;

const range = process.argv[2]?.match(/^(\d+)-(\d+)$/);
const picked = REQUESTS.map((text, i) => ({ text, n: i + 1 })).filter((r) => !range || (r.n >= +range[1] && r.n <= +range[2]));

// Like the app (it warms the router when Ctrl+K opens): the first request would otherwise wait minutes for the model to load.
{
  const { routerModel, warmRouter } = await import("@/server/agents/assistant");
  const t0 = Date.now();
  warmRouter(ctx, false);
  for (let i = 0; i < 90; i++) {
    const loaded = await fetch(new URL("/api/ps", process.env.OLLAMA_URL ?? "http://127.0.0.1:11434")).then((r) => r.json() as Promise<{ models?: { name: string }[] }>).catch(() => ({ models: [] }));
    if (loaded.models?.some((m) => m.name === routerModel(ctx))) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`(model warmed in ${Math.round((Date.now() - t0) / 1000)} s)`);
}

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
  const row = { n, text, intent: direct.intent, understood: (direct as { understood?: string }).understood ?? "", askedMs, totalMs: Date.now() - t, state: board?.state, status: board?.status, asked: (direct as { asked?: boolean }).asked ?? false, answer: answer.slice(0, 1200), items: ((board?.answer?.items ?? direct.items ?? []) as { title: string; detail?: string }[]).map((i) => `${i.title}${i.detail ? ` — ${i.detail}` : ""}`).slice(0, 12), proposed };
  const exp = EXPECTED ? EXPECTED[n - 1] : undefined;
  if (exp) {
    const auto: string[] = [];
    const shown = ((board?.answer?.items ?? (direct as { items?: { title: string; detail?: string }[] }).items ?? []) as { title: string; detail?: string }[]).map((i) => `${i.title} ${i.detail ?? ""}`).join(" ");
    for (const re of exp.must ?? []) if (!re.test(answer + " " + shown + " " + proposed.join(" "))) auto.push(`missing ${re}`);
    for (const re of exp.never ?? []) if (re.test(answer + " " + shown)) auto.push(`forbidden ${re}`);
    // Asking instead of acting is a last resort: for the error rate it counts as a miss (the user's rule).
    if ((direct as { asked?: boolean }).asked) auto.push("ASKED a question instead of acting (counts as an error)");
    if (exp.proposes === "none" && proposed.length) auto.push(`prepared ${proposed.length} action(s), expected none`);
    if (typeof exp.proposes === "number" && proposed.length !== exp.proposes) auto.push(`prepared ${proposed.length} action(s), expected ${exp.proposes}`);
    Object.assign(row, { want: exp.want, autoCheck: auto });
    console.log(`   ITEMS: ${(row.items as string[]).join(" | ").slice(0, 600)}`);
    console.log(`   WANT: ${exp.want}\n   AUTO: ${auto.length ? auto.join("; ") : "pass"}`);
  }
  rows.push(row);
  console.log(`#${n} [${row.intent}] ${Math.round(row.askedMs / 1000)}s+${Math.round((row.totalMs - row.askedMs) / 1000)}s ${row.state ?? ""} | ${text}\n   → ${answer.slice(0, 300)}${proposed.length ? `\n   ⏳ waiting for approval: ${proposed.join(" | ")}` : ""}`);
}
writeFileSync(path.join(process.env.ACC_DATA_DIR ?? "data", `simulation-${range ? range[0] : "all"}.json`), JSON.stringify(rows, null, 2));
process.exit(0);
