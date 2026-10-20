# Plan, architecture and status

## Phases

| Phase | Scope | Status |
|---|---|---|
| **1 — Core + showcase slice** | Permission engine, approvals, durable scheduler, bounded Chief of Staff workflows, retrieval (BM25 / voyage-4-nano / Atlas + Voyage), dashboard (8 views), CSV import, MCP (stdio), tests | **Done** |
| 1.5 — Daily-use polish | Streamed local answers, model picker + speed test, real RSS feeds (SSRF-safe), worker as a systemd user service, Atlas search with locally embedded queries | **Done** |
| 2 — Real connectors | Gmail and Google Calendar read-only via OAuth (PKCE, exact scopes), encrypted tokens, sync, revoke | **Done — enable via docs/GOOGLE_SETUP.md** |
| 3 — Polish & assets | Reminders, weekly review, schedule creation, command bar, Markdown import, retention, hybrid search (local RRF + Atlas `$rankFusion`), migrations, backups, E2E + accessibility, CSP, theme toggle, CI, README screenshots | **Done** |
| 4 — Personal and demo | Personal app and demo side by side (`ACC_MODE`), simple view, agents panel, colour per permission level, role profiles, offload of idle local models | **Done** |
| 5 — Assistant features | Inbox insights (unanswered threads + nudges, trips & bookings, subscription audit), About me facts, request board, Gmail drafts and an app-owned Google calendar (each behind approval), free-slot proposals, desktop and ntfy notifications, replies in English, French, Spanish and Catalan with a model per language, prompt-injection detection in all four, **Impact card**, recall chart, opt-in **Share to Atlas** for your own notes | **Done** |
| 6 — Understanding and autonomy | Prompt bar redesign, "Not right?" corrections that teach the router, calendar answers computed in code, two-part requests, web answers from matching passages, autopilot (off by default) with Done for you and Undo, cancel a request, optional Mistral cloud models (free tier), memory guard, accuracy measured on fresh held-out request sets (docs/ACCURACY_PLAN.md) | **Done** |
| 7 — Next | API token for local calls, OS keyring for the token key, ICS calendars, a pinned voyage-4-nano checksum, optional Atlas Local (Docker) backend | Ideas |

## Architecture

```
Browser (Next.js client UI)  ──fetch, same-origin JSON──▶  Route handlers (src/app/api/*)
                                                               │  Host check, CSRF check, zod, rate limits
                                                               ▼
                                        Core (src/server/*) — the only place rules live
   ┌──────────────┬────────────────┬──────────────┬─────────────────┬──────────────────────┐
   policy/engine  approvals         scheduler       tools/registry    retrieval/*
   (effective =   (hash-bound,      (cron+TZ,       (typed tools,     (BM25, voyage-4-nano,
    min(svc,agent)) CAS execute)     unique claims)  authorize+budget)  Atlas $vectorSearch,
                                                                       Voyage embed/rerank)
                                                               │
                         SQLite (node:sqlite, data/acc.sqlite) — app data, local vectors
   Worker process (npm run worker) ─┘     MCP stdio server (npm run mcp) ─┘ (same core, same checks)
   Optional: MongoDB Atlas (demo corpus + notes you share) · Voyage AI API · Ollama (localhost only)
```

Key decisions:

- **Next.js 16 + TypeScript.** One process serves both the UI and the API. The core is plain TypeScript, shared with the worker and the MCP server.
- **`node:sqlite` instead of `better-sqlite3`.** It is built into Node, so there is no native compile step on the target machine.
- **Deterministic workflows instead of LangChain agent loops.** A workflow is a fixed list of steps under a tool-call and time budget, and the LLM only writes the final text. This is easier to test and keeps prompt-injected content from steering tool use. LangChain can be added later for retrieval chains if it earns its weight.
- **voyage-4-nano for local semantic search.** It is open weights and shares an embedding space with the hosted voyage-4 models, so local and live mode are directly comparable.
- **An exact vector scan locally, ANN in Atlas.** For a personal corpus of a few thousand chunks, a scan is fast enough; Atlas is the path for when the corpus grows.

## Simulated vs live

| Piece | State |
|---|---|
| Inbox, calendar | **Simulated**: seeded fictional data |
| News | **Live** when you enable RSS sources in Settings; otherwise a sample feed. The briefing labels which one it used |
| Executing approved actions | **Simulated** for the demo services (written to the local `simulated_outbox` table). **Live** for Gmail drafts and the app's own Google calendar, after approval of the exact content; nothing is ever sent |
| Gmail / Google Calendar | **Live, read-only**, once you configure an OAuth client and connect. Access stays None until granted. Inbox insights read headers only |
| Local LLM (Ollama) | **Live, local**, when Ollama is running |
| voyage-4-nano | **Live, local**, after the explicit model download |
| Atlas + Voyage | **Live, cloud**, only when configured *and* confirmed in the UI; every run is labelled. Holds the fictional corpus, plus the notes you share one by one |
| Scheduler | **Live**: fires while `npm run worker` runs. Jobs are marked "simulated sources" while they read sample data |

## Free-tier facts relied on (checked 2026-10-12, may change)

- **Atlas M0:** free, 512 MB storage, Vector Search available, maximum of 3 Search/Vector Search indexes per M0 cluster. This app uses 2 (one vector, one full-text for `$rankFusion`) and stores about 14 small documents. The test cluster runs MongoDB 8.0, which `$rankFusion` requires.
- **Voyage AI:** 200M free tokens per account for each of voyage-4-lite, voyage-4 and voyage-4-large, and for rerank-3-lite and rerank-3. Syncing the demo corpus used about 1.2k tokens, and a live query with rerank uses about 0.2–1k. Without a payment method the account is limited to 3 requests/min and 10k tokens/min; the app paces itself (`VOYAGE_MAX_RPM`).
- **Billing:** both services bill beyond their free allowances. The app never creates clusters, changes tiers or loops over the API. Watch your usage dashboards.

## Remaining work before connecting real personal accounts

1. **Authentication:** add user authentication if the app is ever reachable from anywhere other than localhost. The current model is a single local user, with Host and CSRF checks but no login.
2. ~~OAuth connectors~~ **done** (PKCE, exact scopes, encrypted tokens, refresh, revoke). Next step: move the token key into the OS keyring.
3. ~~Real executors~~ **done for Gmail drafts and the app calendar**: per-connection request allowlist, provider-side idempotency (stable event ids), and the approval view is the exact payload. Anything that *sends* stays out of scope.
4. ~~Data minimization for real email~~ **done**: only headers are synced and stored; bodies are read on demand by `gmail.readonly` for a reply draft, processed locally and never stored; retention settings.
5. ~~Content Security Policy~~ **done** without nonces (see docs/SECURITY.md for the trade-off).
6. **Encrypted SQLite:** encrypt the local database (or rely on full-disk encryption), and document backups.
7. **MCP:** consider an HTTP transport only with real auth and the listener bound to localhost.
8. ~~Worker supervision~~ **done** (`npm run worker:install`, restarts on failure). Alerting on repeated failures is still open.
9. **Model download integrity:** pin the voyage-4-nano revision or checksum.
