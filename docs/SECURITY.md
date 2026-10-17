# Security model

Agent Command Center is a **single-user, local-first** app. It is designed to sit next to personal data (an inbox, a calendar, notes) and to let small AI agents work on it, without those agents ever acting beyond what the user explicitly allowed.

This document lists what is protected, from whom, how, and what is **not** covered yet.

## Assets

| Asset | Where | Protection |
|---|---|---|
| OAuth tokens (Google) | SQLite, encrypted | AES-256-GCM, service id as AAD, key in `~/.config/agent-command-center/token.key` (0600), never sent to the browser |
| API keys (Atlas, Voyage) | `.env.local` | Server-only config. Validated at startup, but values are never echoed in errors or logs |
| Personal data (mail headers, events, notes) | SQLite, `data/` (git-ignored) | Minimized on sync (no bodies, descriptions or attendees), retention settings, export and delete. The data folder is owner-only (0700), the database and backups 0600, and `.env.local` should be 0600 too |
| Ability to act (send, create, change) | Approval flow | Agents can only propose. Every effect needs approval of the exact content. The only real writes are Gmail **drafts** and events in a calendar the app owns; nothing is ever sent |

## Trust boundaries and threats

| Boundary | Threat | Mitigation |
|---|---|---|
| Browser → API | Another website calling the local API (CSRF), DNS rebinding | Host allowlist (localhost only). Mutations require a same-origin `Origin`, JSON content type and a custom header. Responses carry no CORS headers |
| Browser rendering | XSS from synced or imported content | React escapes all text. The only raw HTML is a constant, data-free theme script in the layout. A CSP restricts scripts, connections, images and fonts to this origin, with `object-src 'none'`, `frame-ancestors 'none'` and `base-uri 'none'` |
| Untrusted content → LLM | Prompt injection in emails, notes, feeds, CSV or Markdown | Content is fenced as data and flagged. The LLM has **no tools**: it only writes text. Agents' actions come from fixed code paths, never from model output. Tests show a fully "convinced" model changes nothing. For reply drafts, an email whose text is aimed at an AI ("ignore your instructions…", in English, French, Spanish or Catalan) never reaches the model: you get a holding reply to edit instead. Ordinary risky content (a password mention, a forward, a money request) gets a ⚠ and is still drafted for your review |
| User request → skill | A request (or the model reading it) triggering something the user didn't ask for | The local model only reads the user's own request text (never email content) and must answer with one skill name from a fixed list, as JSON checked against a schema: an unknown skill is rejected. Each skill is ordinary code that goes through the policy engine like any agent tool; none can send, approve, delete, pay or change access, and requests to do so are refused before the model is asked. Dates, times and remembered facts are read from the user's own words by code, never taken from the model (a test pins that a question misrouted to “remember” stores nothing). New read-only tools: Gmail search and on-demand message reading for the Inbox agent, a calendar window read for the Calendar agent, a 7-day forecast for any place (Open-Meteo). Email text the skills read is fenced as data, never stored, and AI-directed emails are kept from the model |
| Agent → data | An agent reading or writing beyond its role | Server-side policy engine on every tool call: effective access = min(service, agent, role profile). Each agent's **role profile** (`src/server/policy/profiles.ts`) is the most its code ever needs per service; grants above it are refused, ignored if tampered into the database, and trimmed (and logged) on startup. Tools are bound to one service each, so demo grants never reach real data. A per-run tool-call and time budget applies. Agents cannot change permissions |
| Approval → effect | Approving one thing and executing another, double execution | Approval bound to the SHA-256 of kind, service, destination and payload. Edits clear the approval. Execution re-checks the hash and the live permission, and uses compare-and-set plus a unique outbox key. An execution interrupted mid-call is marked "outcome unknown" and never retried automatically. Idempotency keys can't be reused across agents, services or action kinds |
| Scheduler | A job running after access was revoked; duplicate runs | Requirements re-checked before every run. Jobs block with a reason. Runs are claimed with UNIQUE(job, slot) |
| Server → internet (RSS) | SSRF to internal services or cloud metadata | https on port 443 only; no IP literals or local hostnames. Every resolved address is checked **at connect time** (blocks private, loopback, link-local and metadata ranges, and DNS rebinding). Each redirect hop is re-validated. Responses are size-capped and time-limited, and DTDs are refused |
| Server → Google | Over-broad access, token theft, mail content leaking | PKCE with a one-time 10-minute state. The granted scopes must exactly match the request (otherwise the token is revoked). Read-only scopes only, and services are capped at Read. Message bodies are read only on demand (one message, to draft a reply), passed fenced to the **local** model, and never stored, logged or sent to a cloud service. API calls go only to fixed hosts. Disconnect revokes at Google and deletes synced data |
| Server → internet (web search) | Searches building a profile of you; SSRF through result links; injected instructions in web pages | Searches go only to your own SearXNG on this computer (the URL must be a loopback address), which queries public engines without an account or cookies. Result pages are read with the same connect-time SSRF guard as feeds (https, public addresses, redirects re-checked), capped at 1 MB, HTML stripped. Page text is untrusted data, fenced for the model, and a page that tries to instruct an AI is dropped. Off (None) until you grant the Knowledge agent Read |
| Server → LLM | Data silently sent to a hosted model | The LLM URL must be localhost, and there is no hosted fallback |
| Server → Atlas / Voyage | Sending private data to the cloud | Off by default. Live mode needs config plus an in-app confirmation, per instance. The demo syncs only the fictional corpus. In the personal app, a note goes to Atlas only when you tick **Share to Atlas** on it (off by default); email, mail headers, events and About-me facts never do. Shared chunks carry a random per-instance `origin`: searches and clean-ups filter on it, so another instance on the same cluster (the demo, a test run) can't read or delete them. Unsharing, deleting the note or clearing your data deletes it from Atlas **first**, and nothing changes locally if Atlas can't be reached |
| Server → Google app calendar | Calendar access used beyond the events you approve | Separate consent and token with `calendar.app.created`, which Google limits to calendars this app created. The allowlist permits only two calls: create its own calendar, and insert an event into a calendar that isn't `primary`. There are no reads, edits or deletes. Each event needs an approval of the exact content, uses a stable event id (retries can't duplicate it), and there's a cap of 20 a day. A setting turns this off in favour of Google's pre-filled page |
| Server → Gmail drafts | A compose-scoped token used to send or read mail | Separate consent and token from read-only Gmail. The only call is `POST /users/me/drafts`, after an approval of the exact text, and the token can't be used for reads. RFC 2822 headers reject line breaks (no header injection). Revocable on its own. Residual risk: anyone who steals the token *and* the key file could send mail, so revoke it if the machine is compromised |
| Server → automation webhooks | An agent triggering arbitrary automations, URL leakage, SSRF | Only the user registers webhooks. URLs are encrypted at rest and shown only as host and fingerprint. Each webhook is its own service (None by default). Agents can only *propose* a call. Approval is bound to the exact JSON **and** the URL fingerprint. Calls use https, connect-time IP checks, no redirects, a 4 KB cap and an Idempotency-Key, and response bodies are discarded |
| Server → ntfy (phone push) | Mail details leaking through a third-party push server | Off until you enter a topic URL, which is stored encrypted and fetched with the same SSRF guard as feeds. Pushes carry a generic line ("1 item waiting for your approval"), no names or subjects, unless you opt in to details. One push per event, at most 12 an hour. Desktop notifications stay on this machine, and subjects are escaped and passed after `--` so they can't act as `notify-send` flags |
| Personal app vs demo | Fictional data mixed with yours, or the demo reaching your accounts | `ACC_MODE`: the personal app hides demo services and rows, and the policy engine treats those services as off. The demo refuses real accounts (Google, weather, webhooks, phone push) and uses its own data folder. "Reset demo data" is refused in the personal app |
| MCP client | An unconfigured or unknown client using the tools | stdio only (no listener) and a token compared in constant time. Same permission checks as agents. No write, send or approve tools |
| Logs | Secrets or private content in logs | The activity log redacts sensitive keys and stores summaries only. Server errors are redacted (connection strings, bearer tokens, key=value secrets) |

## Your Gmail and Calendar: why they can't be modified

These layers are independent, so no single bug or tampered row is enough:

1. **Scopes:** Gmail and Calendar are read-only grants (`gmail.readonly`, `calendar.events.readonly`). Google itself refuses writes with these tokens.
2. **Code-level read-only cap:** Gmail, Calendar, Weather, notes and news are capped at Read in the policy engine, whatever the database says.
   Role profiles narrow this further: only the Inbox and Follow-up agents can ever read Gmail, and only the Calendar agent can read Google Calendar.
3. **No write action kinds:** "send email" can only target the demo inbox, and real Gmail can only receive an approved *draft*. "Create event" can target the demo calendar or the app's **own** calendar (a separate `calendar.app.created` connection), never your main calendar.
4. **Request allowlist:** every token-carrying request passes one function with an exact method, host and path allowlist per connection. Gmail and Calendar may only `GET` messages and events. Gmail drafts may only `POST /gmail/v1/users/me/drafts`; even `/drafts/send` is refused. For Undo of autopilot only, two deletes exist: one Gmail draft by the id Gmail returned when the app created it, and one event in the app's own calendar by the id the app derived from its action (32 hex characters). Nothing else can be deleted, and tests pin both the allowlist and the two call sites.
5. **Scope re-check:** before any token is used, its stored scopes must exactly match the expected grant.
6. **Approval + cap:** each draft needs approval of its exact text, at most 20 drafts a day, and nothing is ever sent.
7. **Build-breaking tests:** a source scan fails the test suite if a Gmail send/modify/trash/delete or a Calendar write endpoint appears anywhere in the code, and only the Google connector may talk to Google at all.

## Autopilot (off by default)

Per kind, the owner may let the app act without a click: calendar events (app calendar) and Gmail drafts (never sent) that the
owner asked for in their own words. The decision is one pure function, `mayAutoRun` (src/server/autopilot.ts), table-tested
against docs/AUTOPILOT_SECURITY_TESTS.md: anything derived from email or web text always waits; sending, deleting, paying,
webhooks and permission changes are never automatic; ambiguous times, events more than 60 days away or longer than 12 hours,
and drafts to an address not in the owner's mail wait; at most 3 automatic actions an hour and 10 a day (counted from the
actions themselves, so a restart doesn't reset it). An automatic action is approved as "autopilot" through the same permission
check as a click, so it can never exceed an agent's level. A pause switch in the header returns everything to "Ask first";
every automatic action is in the activity log and in "Done for you" with Undo. Settings change only from the Settings page,
never from a request's words.

## Optional cloud help for understanding requests (off by default)

When the owner turns it on (Settings), the typed Ctrl+K request and the fixed skill list are sent to Mistral's API
(api.mistral.ai, EU) to choose a skill. Nothing else is sent: no email, note, calendar entry, draft or answer, and the self-check
stays local. The API key is sealed with the app's AES-GCM key (like OAuth tokens) and never returned by any API. The feature is
off in the demo instance, capped per day, and falls back to the local model on any error (a rate-limit, quota, payment or key
error also pauses it until the next day). The destination URL is fixed in code.

## Known limitations (deliberate, documented)

- **No user login.** The app assumes one person per OS account and listens on 127.0.0.1 only. Anyone who can run code as your OS user can read the database and the token key. Exposing the app on a network requires real authentication first.
- **CSP allows inline scripts.** Next.js inlines its bootstrap script, and nonces would require fully dynamic rendering, which is incompatible with the Partial Prerendering this app uses. External scripts, exfiltration to other origins, plugins and framing are still blocked.
- **Local database is not encrypted.** Rely on full-disk encryption. Only OAuth tokens are encrypted at the application level.
- **Testing-mode Google apps** expire refresh tokens after 7 days, so you need to reconnect weekly.
- **Rate limits are in memory, per process.** That is enough for a single local user, not for a shared deployment.
- **Model downloads** (voyage-4-nano) are not pinned to a checksum yet.

## Verifying

- `npm test`: 375 unit and integration tests, including denied operations called directly, approval binding, SSRF checks, OAuth state and scope checks, prompt-injection cases in four languages, Atlas sharing scope and removal order, and request-guard bypass attempts.
- `npm run test:e2e`: 15 browser journeys plus automated accessibility scans in light mode, dark mode and at phone width. The run fails on any CSP violation.

## Reporting

This is a personal project. If you find a problem, open a private security advisory on the repository rather than a public issue.
