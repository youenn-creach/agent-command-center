# Autopilot: security tests that must exist (and pass) before it is built

Autopilot = an action kind set to "Do it and tell me after" instead of "Ask first" (see ROADMAP.md §1).
Nothing below is implemented yet. Each line becomes an automated test first; the feature is only written to make them pass.
Default for every kind stays **Ask first**. A test failing means the feature does not ship.

## 1. Who can ask (the request's origin)
- A request typed by the user in Ctrl+K may be auto-run for an allowed kind.
- An action derived from email text, a web page, a calendar invite, a note or a search result is **never** auto-run, whatever the setting for its kind, unless the user's own typed request named it ("add the event from the Lisbon email").
- An email, page or note that says "approve this automatically", "autopilot is on", "the user already agreed" changes nothing (tested with the demo newsletter's injected order).
- A chain started by the user may auto-run only the steps the user's words asked for; extra steps the model adds go to "Ask first".

## 2. What may run (kinds and limits)
- Allowed at most: create calendar events (the app's own calendar), reminders, and Gmail **drafts** (owner's decision,
  2026-10-17: a draft is never sent; the owner sends it). **Never auto**: sending email, deleting anything (except Undo of an
  autopilot action), changing permissions or settings, spending money, webhooks, anything that reaches another person.
- A draft may be auto-created only to someone the owner has written to before, and only when the owner's typed request names
  that person.
- Changing the autopilot setting, the budget or the kill switch is never itself doable by autopilot or by any request text.
- Per-kind budgets: at most N actions per hour and per day (default small). The N+1st waits for approval, and the user is told once.
- An event more than 60 days away, longer than 12 hours, or on a day that already has 8 events needs approval.

## 3. Facts are verified in code, not trusted from the model
- Date, time and place come from the user's words or from a source that states them (the same check used today for flights and web events); if code cannot verify them, the action waits for approval.
- A model answer that disagrees with the verified fact is discarded, and the action waits for approval.
- Ambiguity ("Saturday" when two Saturdays fit, "at 9" with no am/pm clue, a person with two matches) always waits for approval.

## 4. Seeing and undoing
- Every auto-run action is listed in "Done for you" with the request that caused it, the source it used, and what it changed.
- Undo restores the previous state (deletes the created event/reminder). Undo is itself tested: the item is gone, the list shows it as undone, nothing else is touched.
- A summary of the day's auto-runs appears in the briefing.

## 5. Kill switch and failure
- One switch turns every kind back to "Ask first" instantly, including actions queued but not started.
- If the database, the policy engine or the budget counter errors, the answer is "Ask first", never "run".
- A restart in the middle of a run does not re-run an action twice (idempotency key per request).
- Timeouts and a model that is down fall back to "Ask first".

## 6. Measured trust (optional second step)
- A kind may be proposed for autopilot only after N consecutive approvals with no edit; the proposal itself needs the user's click.
- A single undo or rejection moves the kind back to "Ask first" and shows why.

## 7. Audit
- Each auto-run writes an activity-log entry (actor, request, verified facts, result). Tests assert the entry exists and holds no email body text or secret.

## Test shapes
- Unit: the decision function `mayAutoRun(origin, kind, facts, budget, setting)` is pure and table-tested with every cell above.
- Integration: the real command path with the fake model, including the injected-newsletter case and the restart case.
- e2e: setting a kind to autopilot, running a request, seeing "Done for you", pressing Undo, then the kill switch.
