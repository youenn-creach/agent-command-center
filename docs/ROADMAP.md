# Roadmap

Ideas the owner wants, in the order they were agreed. Each one says what has to be true before it is built.

## 1. Autopilot: acting without a click (owner's end goal)

> Security tests to write before any code: [AUTOPILOT_SECURITY_TESTS.md](AUTOPILOT_SECURITY_TESTS.md).

Today every effect (a calendar event, a reminder, a reply draft, a webhook) waits for a click in the Action Queue. The goal: a switch the owner can turn on, per kind of action, so the app does the safe things by itself, with the click kept as the default and always available.

The permission model already has the level (`auto_act` in `src/server/policy/levels.ts`); it is refused in code today. Turning it on is a design job, not a rewrite. What it should look like:

- **Per action kind, not one big switch.** Off / Ask first (today) / Do it, tell me after. Defaults: everything stays "Ask first".
- **Start with what can be undone.** Adding a calendar event to the app's own calendar and creating a reminder are undoable; a Gmail *draft* is too (it is never sent). Sending mail, webhooks that trigger other systems, and anything financial stay on "Ask first" unless the owner separately and explicitly lifts them, one kind at a time.
- **The app must be sure, in code, not by the model's say-so.** Before acting alone, checks the code can verify: the date is a real day and not in the past; the source (an email, a web page) is quoted back and still matches; no duplicate already exists; nothing in the source looks like instructions to an AI; the sender is one the owner has written to before (for anything that answers someone). If any check fails, it falls back to "Ask first" for that item and says why.
- **A budget.** At most N automatic actions per hour and per day, then it asks. A burst (a flood of emails) can't make it act 50 times.
- **Always undoable and visible.** Every automatic action appears in an "Done for you" list with one-click Undo (deletes the event/reminder it made), and a notification if the owner wants one. An undo window before anything leaves the machine.
- **A kill switch** on the dashboard header that returns everything to "Ask first" at once.
- **Measured trust.** The Impact card already counts approvals; add "accepted without change" per kind. Suggest turning autopilot on for a kind only after, say, 20 approved-unchanged actions in a row, and show that number.
- **Security tests to write first:** a prompt-injected email can never trigger an automatic action; a tampered database can't raise a kind above its ceiling (the same code-level caps as read-only services); the budget holds under a flood; undo really removes what was made.

**Owner's decisions (2026-10-17):** the first kinds are **calendar events, reminders and Gmail drafts** (a draft is never sent:
the owner sends it from Gmail). Anything derived from email text ("add the event from my mail", deadlines to reminders, flights
from booking emails, drafted answers to other people's mails) **stays on "Ask first"**: only what the owner typed may act alone.
Reminders are already created at once today (local, deletable); autopilot adds them to "Done for you" with Undo.
Status: in progress (2026-10-17).

## 2. Model quality levels: done (2026-10-15/16)

Decided: Ministral 3 8B for everything (background and interactive), measured on fixed evaluation sets; Qwen 3.5 9B no
better and 2-2.5x slower; the 3B 8-12 points worse. Details: progress.md and ACCURACY_PLAN.md. The original plan follows.

### Original plan

Question: does the app use the right model for each job, and would a "maximum smartness" switch help?
Today: two slots (background, interactive), plus an optional model per reply language. Every task uses the background model (Ministral 3B by default).

Proposed levels, fixed per task in code (never chosen by a model on the fly): **Fast** (routing, simple lookups), **Standard** (today), **Careful** (answers that state facts: web answers, the email review, finding dates), plus an opt-in **Maximum** switch in Settings that uses the largest installed model everywhere, with the time cost spelled out and disabled while another heavy program runs.

The test (run it with the owner's computer idle, no briefing running, Claude desktop closed; several hours):
1. Router eval (`scripts/assistant-eval.mts`, 95 requests) once per candidate model: ministral-3:3b, gemma3:4b, mistral, qwen3-14b. Record accuracy and seconds per request.
2. A fact-check set (to write): 30 questions with known answers and pages to read (web answers) and 20 emails with known facts (dates, amounts, references). Record correct / wrong / invented detail per model.
3. A date-extraction set: 20 emails with an event date, per model, including emails in French, Spanish and Catalan.
4. Decide with numbers: build the levels only if the larger model is clearly better on facts and the extra time is acceptable; if the gap is small, keep today's setup and drop the idea.
Candidates, refreshed 2026-10-14 from web searches (third-party guides: verify tags on ollama.com before pulling; the owner leans Mistral and wants a rival to be more than 5% better before it replaces a Mistral model):
- **Mistral family:** `ministral-3:3b` (what runs today; Dec 2025, the newest small Mistral), **`ministral-3:8b`** (same release, ~6 GB download, strong in European languages, 256K context; the natural "Careful" model), `mistral:latest` (7B, older). Mistral Small 4 (119B mixture-of-experts) and Large 4 are far too big for this machine.
- **Rivals worth testing:** Qwen 3.5 in 4B and 9B (best multilingual reputation, good structured output), Gemma 4 E4B (documented weaker at strict JSON), Phi-4-mini 3.8B (fast on CPU). No source compared them on French/Spanish/Catalan JSON, hence the owner-data test below.
- **Keep:** Salamandra 7B for Catalan. **Delete when the test starts (owner's OK, 2026-10-14):** qwen3-14b-abliterated (9 GB, too big, safety removed), gemma3:270m and :1b (too small), and `mistral:latest` (7B, outdated next to Ministral 3 8B; the owner agreed to delete it, but keep it until `ministral-3:8b` has been pulled and works, since it is the only Mistral model besides the 3B). Download approval GIVEN (owner, 2026-10-14) for the candidate models, on one condition: check free disk space at download time (`df -h ~`; each candidate is 5–6 GB, keep at least 3 GB free afterwards) and stop and tell the owner if there isn't enough. The owner can free disk if a candidate needs it (~11 GB free now).
Constraints: only one model in RAM at a time (about 12 GB total); qwen3-14b needs ~9 GB, so nothing else may run during its pass; unload between models.

## 3. Web search for everyone: done (SearXNG)
## 4. Parked: "Ask Claude" cloud boost (see progress.md, options A–D)


## Accuracy plan (2026-10-15)
See [ACCURACY_PLAN.md](ACCURACY_PLAN.md): fixed evaluation set with automatic grading, example library with local similarity
search, structured calendar/mail queries, planner fallback, mistakes log and one-click corrections. Model: Mistral 8B (decided).
Parked: fine-tuning a router (paid GPU) and cloud help for understanding (privacy trade-off), only if really needed.

## 5. A real prompt bar: done (2026-10-16)
The command bar (Ctrl+K and the bar on the page) runs the whole app, but it looks like a small generic search field. Make it
look and feel like a modern prompt bar:
- Larger and more prominent, with a subtle "magic / high-tech" touch: a soft glow or gradient border, a quiet animated shimmer
  while the assistant thinks, nothing loud. It follows the app's light and dark themes.
- Long requests stay readable: the field grows to several lines (auto-height textarea, wraps instead of scrolling sideways),
  Enter sends and Shift+Enter adds a line.
- It keeps every current behaviour: Ctrl+K, the typing suggestions, "understood as…", the request board, keyboard use and the
  Playwright tests.
