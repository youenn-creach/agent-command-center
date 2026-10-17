# UI review (2026-10-17)

A pass over every section (demo instance, desktop and phone), measured in the browser (headings, word counts, controls,
targets smaller than 24×24 px), compared with current guidance on dashboards, agent interfaces, command palettes and
WCAG 2.2. Ideas only: nothing here is built yet. Ranked by expected benefit; "keep" items are at the end on purpose.

## What the pages look like today (measured)

| Section | Words | Controls | Targets < 24 px | Notes |
|---|---|---|---|---|
| Today | 242 | 13 | 2 | 4 counters + Impact card (6 figures, mostly 0 on a quiet week), briefing, running-now panel, reminders, requests, agenda, waiting on you |
| Action Queue | 71 | 0 | 0 | empty state + history + simulated outbox |
| Inbox insights | 181 | 4 | 0 | |
| Agents | 221 | 0 | 0 | 17 badges, read-only |
| Scheduled Agents | 388 | 21 | 4 | |
| Connections & Permissions | 579 | 16 | 0 | |
| Under the hood | 609 | 39 | 24 | example-question chips are small |
| Knowledge & Data | 332 | 9 | 2 | |
| Activity Log | 94 | 11 | 0 | |
| Settings | 1000 | 64 | 29 | 11 cards, ~2,900 px tall; checkboxes ~14 px |

The sidebar holds 10 sections plus four status blocks (5 agents all "Standby", 6 connections, 2 cloud services, runtime).

## Ideas, by expected benefit

### 1. Today answers "what now?" first (high benefit, medium effort)
Dashboard guidance converges on one thing: lead with the answer to the main question, the most important item largest and
first, detail behind a click ([DesignRush](https://www.designrush.com/agency/ui-ux-design/trends/dashboard-design-principles),
[UX studio](https://www.uxstudioteam.com/ux-blog/dashboard-design)). Today opens with four counters and an Impact card that
is mostly zeros on a quiet week.
- A top "Next" strip built by the existing `priorities` code: the next event (time, place), the first mail that needs you, the
  first reminder due. Three lines, each with its action (open, reply, done).
- The Impact card shows only figures that aren't zero, or folds into one line ("This week: 2 nudges answered, ~25 min saved")
  until there is something to show.
- The running-now panel (CPU, memory) only appears while something runs, or in the technical view.

### 2. One place for "needs you" and "done for you" (high, small-medium)
Agent-UX guidance treats approvals, receipts and undo as one control surface, the human placed at the risky moments
([Hatchworks](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/), [Smashing](https://shop.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/),
[UX Magazine](https://uxmag.com/articles/secrets-of-agentic-ux-emerging-design-patterns-for-human-interaction-with-ai-agents)).
With autopilot, the Action Queue (needs you) and "Done for you" (Today) are two halves of the same thing in two places.
- An "Actions" page with two tabs, **Needs you** and **Done for you**, and the count of each in the sidebar.
- The header autopilot pill shows today's count ("Autopilot · 2 done today").

### 3. The prompt bar suggests and remembers (high, medium)
Command-palette practice: suggestions from recent and frequent actions, people and content, not a fixed catalogue; an empty
state that teaches; arrows/Enter/Esc; combobox semantics for screen readers
([command palette pattern](https://skillselion.com/skills/thedaviddias/ux-patterns-for-developers/command-palette),
[Linear/Vercel-style build](https://www.techinterview.org/post/3233475212/build-command-palette-cmd-k/)).
This is also Phase D3 of the accuracy plan (suggestions steer toward what is understood reliably).
- On focus, an empty bar shows your 3 recent requests and 3 templates that fit the moment (morning: "what's on today";
  someone waiting: "nudge Priya").
- While typing, known names and request templates complete inline (Tab accepts).
- Announced as a combobox (`role="combobox"`, listbox, live region for the count).

### 4. Settings in groups, with the frequent ones first (medium, small)
1,000 words and 11 cards on one 2,900 px page. Guidance: keep frequent controls visible, tuck advanced ones away
([Alphonso Labs 2026 checklist](https://www.alphonsolabs.com/saas-dashboard-ux-requirements-2026/amp/)).
- Three groups with a small in-page index: **Assistant** (autopilot, models, cloud help, notifications), **Data** (news,
  weather, retention, calendar mode), **Advanced** (webhooks, scheduler worker).

### 5. Targets of at least 24 px (medium, small: accessibility)
WCAG 2.2 adds 2.5.8 Target Size (AA): 24×24 px or enough spacing ([Deque](https://dequeuniversity.com/resources/wcag-2.2),
[TetraLogical](https://tetralogical.com/blog/2023/10/05/whats-new-wcag-2.2)). Settings has 29 smaller targets (14 px
checkboxes, small links), Under the hood 24 (question chips), Scheduled Agents 4 ("History").
- Checkboxes and radios at 18 px inside a 24 px hit area; chips and small links padded to 24 px height. Add an automated check
  next to the existing axe tests so it stays that way.
- Also check 2.4.11 Focus Not Obscured: the sticky header must not cover a focused field when tabbing up the page.

### 6. A quieter sidebar (medium, small)
Navigation plus four status blocks compete for attention; "Standby" ×5 says little. Progressive disclosure: show what
changes or needs action, the rest on demand.
- Keep the 10 sections (maybe grouped: Daily / Set up / Advanced); collapse the status blocks into one line ("All quiet ·
  local model ready") that opens the details, and show a block only when something is off (a connection broken, the worker
  stopped, a model missing).

### 7. Intent preview for anything that leaves the machine (medium, small)
"Show the plan, then proceed / edit / do it myself" is the most cited agent pattern
([Smashing](https://shop.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)). The app already does
this for events (card with Approve). Extending the same card to drafts (the text, To, Subject, with Approve / Edit / Copy)
right in the prompt bar answer would save a trip to the Action Queue.

### 8. Measured trust, visible (low-medium, small)
The same sources suggest tracking "accepted without edit" and letting users raise autonomy themselves. The Impact card can
show "approved unchanged: 18 of 20 events" per kind, with the suggestion to turn on autopilot after 20 in a row (step 6 of
docs/AUTOPILOT_SECURITY_TESTS.md).

### 9. Copy that is now out of date (small, small)
- Reminders card: "Approved from the Action Queue" and "Agents propose reminders; approve one to see it here": reminders you
  ask for are added at once. Suggest: "Yours and the agents'. Tick one off when done."
- Today's lead sentence "Nothing leaves this machine without your explicit approval" is no longer always true once autopilot
  is on: "…without your approval, unless you turned on autopilot for it."

## Keep as is (checked, no change needed)
- The prompt bar redesign (2026-10-16): wide, multi-line, Enter / Shift+Enter, glow while working.
- "Understood as … · Not right?" under answers: matches the "user can correct the agent" guidance.
- The pause switch one click away in the header, "Done for you" with Undo: matches the "visible stop control" and
  "reversibility grows with autonomy" guidance.
- Dark mode, the phone layout (no sideways scroll), the existing axe checks in light and dark.
- The demo/personal split and its badges.

## Suggested order, if any is built
9 (minutes) → 5 (accessibility, small) → 1 and 2 (the biggest gain) → 3 (with the accuracy plan's D3) → 4, 6, 7, 8.
