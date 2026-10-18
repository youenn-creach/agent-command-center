# Accuracy plan (complex requests, Mistral 8B)

Agreed with the owner on 2026-10-15. Goal: 90% of complex requests handled right WITHOUT asking (an ask counts as a miss).
The model is decided (Mistral 8B; Qwen 3.5 9B was not better on three held-out batches and is 2-2.5x slower). Everything below is
done without the owner's intervention. Not in scope: fine-tuning or anything paid/cloud (the "cloud help for understanding" idea
is parked for later, only if really needed).

## Why the method changes
Held-out error rates did not fall (42% → 58% → 62% on batches 4, 7, 8) although many real bugs were fixed: each new batch was
written to explore new ground (the measurement drifts), most fixes were wording rules that don't carry over to paraphrases, and
about half of the errors were missing abilities rather than misunderstandings.

## Phase A: measure properly (first)
1. **Fixed evaluation set v1**: ~160 requests stratified by category (calendar questions and adds, reminders, mail questions and
   actions, notes, web, trips, two-asks-in-one, vague/unsupported/injection, summaries), written once, on the same fictional data.
   Split: **dev (≈100)** used for tuning, **test (≈60)** held out and never tuned on. Older batches 3-9 become a regression suite.
2. **Automatic grading**: machine-checkable expectations per request (accepted final skills, facts that must appear, facts that
   must not, actions/reminders/events expected with dates). Each failure is classified: misunderstanding, missing ability,
   wrong or invented fact, asked (= miss).
3. **Fixed clock** for evaluation runs (Thu 15 Oct 2026, 10:30 Madrid), also in the fake Gmail, so expectations never go stale.
4. Runs from a frozen git worktree (node_modules, .env.local and models/ symlinked), under scripts/sim-supervisor.mts.
5. Baseline: dev + test on the current code.

## Phase B: understand requests better without wording rules
1. **Restate before choosing**: the router writes a one-line goal before the skill (JSON field order). Checked on the routing eval.
2. **Example library with similarity search**: a few hundred labelled requests (never the test set); the 8 nearest (local
   voyage-4-nano embeddings, already installed; keyword fallback) are shown to the router as worked examples. Every fixed
   failure becomes an example, so fixes carry over to paraphrases.
3. **Model-based splitting** of two-part requests (a short dedicated call when the text joins clauses), regex as fallback.
4. **Voting on uncertain cases**: route several times; disagreement → self-check / retry. Kept only if dev improves.
5. Two-step routing (area, then action): tried on dev, kept only if better.

## Phase C: abilities by design
1. **Structured calendar query** (range, keyword, asked field: time/place/who/duration/free/next/count/list/left): one handler,
   answers built by code.
2. **Structured mail query** (from, about, asked field: when/what/amount/list/count/needs reply), figures grounded.
3. **Coverage matrix** (data kinds × question kinds) written down; gaps closed deliberately.
4. **Planner fallback**: when no skill fits or the self-check fails, up to 3 typed tool steps (calendar, mail, notes, reminders,
   web; read-only or prepared-for-approval), executed by code, answer grounded.

## Phase D: learn from use
1. **Mistakes log** (migration): request, route, signals (rephrased within minutes, undo, "wrong" button), correction.
2. **"Understood as … — not right?"** with one-click alternatives under answers; a choice reruns the request and becomes an example.
3. **Suggestions while typing** in Ctrl+K (request templates and known people), steering toward what is understood reliably.

## Loop and stopping rule
After each phase: dev run (tuning allowed) then, at milestones, the held-out test run from a frozen worktree. Continue while a
round is expected to remove ≥30% of the remaining errors; target <10% on the test set without asking. Report per phase with
category breakdown. Every change: unit tests + whole-pipeline tests; prompt changes also re-run the routing eval and the verdict
suite (regression checks), because small-model prompts are fragile.

## Safety and privacy (unchanged)
Fictional data only for evaluation; real mail is never used. Nothing is sent: drafts and events wait for approval. No downloads
without approval (none needed: the embedding model is already installed). Public repo updated only after a privacy scan.

## Outcome (stopped by the owner, 2026-10-17)
Measured on the local Mistral 8B, every request graded automatically, held-out sets never tuned on:

| Code | Dev v1 (tuned on) | Held-out v1 test | Held-out v2 (fresh) |
|---|---|---|---|
| Baseline (2026-10-15) | 15% | 32% | — |
| Fixes + example library | 4% | 25% | 17% |
| + abilities from v1's held-out failures | 1% | 3% (then tuned on) | 15% |
| + review fixes, autopilot, routing nets (2026-10-17) | — | — | **10%** (54/60) |

Kept: the example library (196 labelled requests + the user's own corrections, nearest 6 shown to the router), the
abilities in Phase C's spirit (calendar questions answered from the events, event-anchored reminders, mail-first amounts and
dates, topic follow-ups), "Understood as … · Not right?" (Phase D2). Measured and turned off: restating the goal (no gain,
18% slower), model-based splitting (no gain, 26% slower), the self-check (measured on v2, same code: 52/60 on vs 54/60 off, 2 answers
made worse, none fixed, +31 s per request; the two v1 requests it had rescued are now routed directly). Not built: voting, the planner fallback, the mistakes log beyond corrections, typing suggestions.
Why stopped: the last rounds removed 10-22% of the remaining held-out errors, under the owner's 30% bar; corrections from
real use are expected to help more from here.

## Second pass (2026-10-17/18, owner away): fresh sets, one per round
v2 had been measured four times, so each round got a NEW held-out set, written and committed before the code it measures.
After a round, that set's failures were studied and fixed (it becomes tuning material) and the next set measured the result.

| Code | Fresh held-out set | Same set after its fixes |
|---|---|---|
| c6: web answers from matching passages, figure check keeps the main clause | v3: 51/60 (15%) | 60/60 |
| c7: v3's fixes (time before the task, calendar-event questions, notes fallback) | v4: 50/60 (17%) | 57/60 |
| c8: v4's general fixes (trips only for travel, questions never "add") | v5: 50/60 (17%) | — |

Reading: about **15-17% errors on wordings never seen**, flat over three rounds. Fixing studied failures makes them pass but
doesn't move the fresh-set rate: each new set finds different gaps. Strong on fresh sets: reminders, notes, mail actions, web,
trips, refusals (all or nearly all right). Weak: calendar questions (5/8) and two-part requests (5/8). v1 dev stayed at 2%.
Speed: web answers 2.25x faster (707 s -> 314 s, same accuracy on 26 questions); a request now averages 77-104 s.
Stopped again under the 30% rule. Next levers are not more wording rules but the user's own corrections ("Not right?")
and, if wanted, the free cloud router for routing only.
