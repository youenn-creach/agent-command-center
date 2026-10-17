import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { all, getSetting, one, run, setSetting, tx, type Ctx } from "../db";
import { config } from "../config";
import { logActivity } from "../activity";
import { disconnectService } from "../policy/permissions";
import { open, seal } from "./secretBox";

/**
 * Google connectors (read-only Gmail and Calendar, plus optional approved Gmail drafts), off until
 * GOOGLE_CLIENT_ID is set.
 *
 * - OAuth 2.0 authorization code flow with PKCE (S256) and a one-time, 10-minute `state`.
 * - Read-only scopes: gmail.readonly and calendar.events.readonly. One consent per service, so each
 *   can be revoked on its own.
 * - Tokens are encrypted at rest (secretBox) and never leave the server.
 * - Connecting does NOT grant agents anything: the service and every agent stay at "None" until
 *   the user raises them in Connections & Permissions.
 * - Data minimization: the Gmail sync stores sender, subject, date and a labels-derived "needs
 *   reply" only. A body is read on demand (readMessageText) for one reply draft and never stored.
 *   Calendar → title, start, end, location; no descriptions or attendees.
 * - Disconnect revokes the token at Google, deletes it, and deletes synced rows.
 * - Only fixed Google API hosts can be called.
 */

export type GoogleServiceId = "gmail" | "google-calendar" | "gmail-drafts" | "google-calendar-app";
export const GOOGLE_SERVICES: GoogleServiceId[] = ["gmail", "google-calendar", "gmail-drafts", "google-calendar-app"];

/**
 * gmail-drafts uses gmail.compose: Google has no drafts-only scope, so this token could send mail
 * at Google's level. The app contains that power in code: createGmailDraft() is the ONLY write
 * call, it can only reach POST /users/me/drafts, and each draft needs an approval. It's a separate
 * consent and token, revocable without touching the read-only Gmail connection.
 */
/** Narrower scopes Google may still report from an earlier grant; harmless, so tolerated. */
const NARROWER_SCOPES: Partial<Record<GoogleServiceId, string[]>> = {
  gmail: ["https://www.googleapis.com/auth/gmail.metadata"],
};

export const SCOPES: Record<GoogleServiceId, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.events.readonly"],
  "gmail-drafts": ["https://www.googleapis.com/auth/gmail.compose"],
  // Only calendars this app creates: it can't see or change your other calendars (Google enforces it).
  "google-calendar-app": ["https://www.googleapis.com/auth/calendar.app.created"],
};

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ALLOWED_HOSTS = new Set(["oauth2.googleapis.com", "gmail.googleapis.com", "www.googleapis.com"]);
const STATE_TTL_MS = 10 * 60_000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "BAD_STATE" | "DENIED" | "SCOPE" | "TOKEN" | "API" | "NOT_CONNECTED" = "API",
  ) {
    super(message);
  }
}

function guardedFetch(fetcher: Fetcher): Fetcher {
  return (url, init) => {
    if (!ALLOWED_HOSTS.has(new URL(url).hostname)) throw new GoogleError(`Refusing to call ${new URL(url).hostname}`);
    return fetcher(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000), redirect: "error" });
  };
}

/** Request schema for any API that names a Google service; derived from GOOGLE_SERVICES. */
export const GoogleServiceSchema = z.enum(GOOGLE_SERVICES as [GoogleServiceId, ...GoogleServiceId[]]);

export function isGoogleService(id: string): id is GoogleServiceId {
  return (GOOGLE_SERVICES as string[]).includes(id);
}

function b64url(buf: Buffer) {
  return buf.toString("base64url");
}

export function pkceChallenge(verifier: string) {
  return b64url(createHash("sha256").update(verifier).digest());
}

function requireConfig() {
  const c = config();
  if (!c.GOOGLE_CLIENT_ID) throw new GoogleError("Google sign-in is not configured. Add GOOGLE_CLIENT_ID to .env.local (see docs/GOOGLE_SETUP.md).", "NOT_CONFIGURED");
  return { clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET, redirectUri: c.GOOGLE_REDIRECT_URI };
}

/** Step 1: returns the Google consent URL for one service, remembering a one-time state + PKCE verifier. */
export function startAuth(ctx: Ctx, serviceId: GoogleServiceId): string {
  const { clientId, redirectUri } = requireConfig();
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  run(ctx.db, "DELETE FROM oauth_pending WHERE created_at < ?", new Date(ctx.now().getTime() - STATE_TTL_MS).toISOString());
  run(ctx.db, "INSERT INTO oauth_pending (state, service_id, code_verifier, created_at) VALUES (?, ?, ?, ?)", state, serviceId, verifier, ctx.now().toISOString());
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES[serviceId].join(" "),
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
  }).toString();
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId, outcome: "pending", summary: `Started Google sign-in for ${serviceId} (${serviceId === "gmail-drafts" ? "drafts only, after your approval" : serviceId === "google-calendar-app" ? "its own calendar only, after your approval" : "read-only scope"})` });
  return url.toString();
}

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

/** Step 2: Google redirects back with ?code&state. Validates, exchanges, encrypts and stores. */
export async function handleCallback(ctx: Ctx, params: { code?: string | null; state?: string | null; error?: string | null }, fetcher: Fetcher = fetch): Promise<GoogleServiceId> {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  if (!params.state) throw new GoogleError("Missing state", "BAD_STATE");
  const pending = one<{ service_id: GoogleServiceId; code_verifier: string; created_at: string }>(ctx.db, "SELECT * FROM oauth_pending WHERE state = ?", params.state);
  // One-time use, whatever happens next.
  run(ctx.db, "DELETE FROM oauth_pending WHERE state = ?", params.state);
  if (!pending) throw new GoogleError("Unknown or already-used sign-in attempt. Start again from the dashboard.", "BAD_STATE");
  if (ctx.now().getTime() - new Date(pending.created_at).getTime() > STATE_TTL_MS) throw new GoogleError("Sign-in attempt expired. Start again.", "BAD_STATE");
  if (params.error) throw new GoogleError(`Google sign-in was cancelled or refused (${params.error.slice(0, 60)}).`, "DENIED");
  if (!params.code) throw new GoogleError("Missing authorization code", "BAD_STATE");

  const body = new URLSearchParams({ client_id: clientId, code: params.code, code_verifier: pending.code_verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
  if (clientSecret) body.set("client_secret", clientSecret);
  const res = await guardedFetch(fetcher)(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const token = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!res.ok || !token.access_token) throw new GoogleError(`Token exchange failed (${token.error ?? res.status}).`, "TOKEN");

  // The grant must contain exactly what we asked for — nothing missing, nothing broader.
  const granted = new Set((token.scope ?? "").split(/\s+/).filter(Boolean));
  const wanted = new Set(SCOPES[pending.service_id]);
  const missing = [...wanted].filter((s) => !granted.has(s));
  // A previously granted, strictly narrower scope of the same kind (gmail.metadata ⊂ gmail.readonly)
  // may be reported alongside; it adds nothing, so it's tolerated. Anything broader is refused.
  const narrower = NARROWER_SCOPES[pending.service_id] ?? [];
  const extra = [...granted].filter((s) => !wanted.has(s) && !narrower.includes(s) && !["openid", "email", "profile"].includes(s));
  if (missing.length || extra.length) {
    await revoke(token.access_token, fetcher);
    throw new GoogleError(missing.length ? "The read-only permission was not granted, so nothing was connected." : "Google granted broader access than requested, so it was revoked and nothing was connected.", "SCOPE");
  }

  const stored: StoredToken = { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: Date.now() + (token.expires_in ?? 3600) * 1000 };
  tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO oauth_connections (service_id, scopes, token_ciphertext, expires_at, connected_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET scopes = excluded.scopes, token_ciphertext = excluded.token_ciphertext, expires_at = excluded.expires_at, connected_at = excluded.connected_at`,
      pending.service_id,
      JSON.stringify([...wanted]), // only the validated, expected grant is recorded
      seal(JSON.stringify(stored), pending.service_id),
      new Date(stored.expires_at).toISOString(),
      ctx.now().toISOString(),
    );
    // Connected, but access stays None until the user grants it explicitly.
    run(ctx.db, "UPDATE services SET connection_state = 'connected', access_level = 'none', scopes = ? WHERE id = ?", JSON.stringify([...wanted].map((s) => s.replace("https://www.googleapis.com/auth/", ""))), pending.service_id);
  });
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: pending.service_id, outcome: "ok", summary: `Connected ${pending.service_id} (${[...wanted].map((s) => s.split("/").pop()).join(", ")}). Access stays None until you grant it.` });
  return pending.service_id;
}

async function revoke(token: string, fetcher: Fetcher) {
  try {
    await guardedFetch(fetcher)(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  } catch {
    // best-effort: the local token is deleted regardless
  }
}

function loadToken(ctx: Ctx, serviceId: GoogleServiceId): StoredToken {
  const row = one<{ token_ciphertext: string }>(ctx.db, "SELECT token_ciphertext FROM oauth_connections WHERE service_id = ?", serviceId);
  if (!row) throw new GoogleError(`${serviceId} is not connected.`, "NOT_CONNECTED");
  return JSON.parse(open(row.token_ciphertext, serviceId)) as StoredToken;
}

async function accessToken(ctx: Ctx, serviceId: GoogleServiceId, fetcher: Fetcher): Promise<string> {
  const t = loadToken(ctx, serviceId);
  if (t.expires_at - Date.now() > 60_000) return t.access_token;
  if (!t.refresh_token) throw new GoogleError("Session expired; reconnect the service.", "TOKEN");
  const { clientId, clientSecret } = requireConfig();
  const body = new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: t.refresh_token });
  if (clientSecret) body.set("client_secret", clientSecret);
  const res = await guardedFetch(fetcher)(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const r = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !r.access_token) {
    if (r.error === "invalid_grant") {
      // Revoked on Google's side: reflect that locally instead of retrying forever.
      await disconnectGoogle(ctx, serviceId, fetcher, "Access was revoked in your Google account");
    }
    throw new GoogleError(`Could not refresh access (${r.error ?? res.status}).`, "TOKEN");
  }
  const next: StoredToken = { ...t, access_token: r.access_token, expires_at: Date.now() + (r.expires_in ?? 3600) * 1000 };
  run(ctx.db, "UPDATE oauth_connections SET token_ciphertext = ?, expires_at = ? WHERE service_id = ?", seal(JSON.stringify(next), serviceId), new Date(next.expires_at).toISOString(), serviceId);
  return next.access_token;
}

/**
 * The ONLY requests a token may ever make, per connection. Exact method + path; anything else —
 * send, modify, trash, delete, insert, patch, settings, another user — is refused before a token
 * is attached. Calendar and read-only Gmail can only GET; Gmail drafts can only create a draft
 * (exact path, so not even POST /drafts/send) and delete one draft by id (Undo of autopilot).
 */
const ALLOWED_REQUESTS: Record<GoogleServiceId, { method: string; host: string; path: RegExp }[]> = {
  gmail: [
    { method: "GET", host: "gmail.googleapis.com", path: /^\/gmail\/v1\/users\/me\/messages(\/[\w-]{1,64})?$/ },
    // One thread's headers, to see whether anyone answered a message you sent (Inbox insights).
    { method: "GET", host: "gmail.googleapis.com", path: /^\/gmail\/v1\/users\/me\/threads\/[\w-]{1,64}$/ },
  ],
  "google-calendar": [{ method: "GET", host: "www.googleapis.com", path: /^\/calendar\/v3\/calendars\/primary\/events$/ }],
  "gmail-drafts": [
    { method: "POST", host: "gmail.googleapis.com", path: /^\/gmail\/v1\/users\/me\/drafts$/ },
    // Undo of an autopilot draft: deletes that one draft (by the id Gmail returned when the app created it). Never a sent message.
    { method: "DELETE", host: "gmail.googleapis.com", path: /^\/gmail\/v1\/users\/me\/drafts\/[\w-]{1,64}$/ },
  ],
  // Create the app's own calendar once, then insert events into it. Never "primary", no reads,
  // updates or deletes (and the scope itself only reaches calendars the app created).
  "google-calendar-app": [
    { method: "POST", host: "www.googleapis.com", path: /^\/calendar\/v3\/calendars$/ },
    // Only a secondary calendar id (xxxx@group.calendar.google.com). Your primary calendar's id is your
    // email address, so a looser pattern would let a tampered setting point at it.
    { method: "POST", host: "www.googleapis.com", path: /^\/calendar\/v3\/calendars\/[\w.-]{1,100}%40group\.calendar\.google\.com\/events$/ },
    // Undo of an autopilot event: deletes that one event in the app calendar (ids the app made: 32 hex characters).
    { method: "DELETE", host: "www.googleapis.com", path: /^\/calendar\/v3\/calendars\/[\w.-]{1,100}%40group\.calendar\.google\.com\/events\/[0-9a-f]{32}$/ },
  ],
};

export function assertAllowedGoogleRequest(serviceId: GoogleServiceId, method: string, url: string) {
  const u = new URL(url);
  const ok = u.protocol === "https:" && ALLOWED_REQUESTS[serviceId].some((r) => r.method === method.toUpperCase() && r.host === u.hostname && r.path.test(u.pathname));
  if (!ok) throw new GoogleError(`Blocked: ${serviceId} may not ${method.toUpperCase()} ${u.hostname}${u.pathname}`, "API");
}

/** Every request that carries a Google token goes through here: allowlist and scope check first. */
async function authedRequest(ctx: Ctx, serviceId: GoogleServiceId, method: "GET" | "POST" | "DELETE", url: string, fetcher: Fetcher, body?: string): Promise<Response> {
  assertAllowedGoogleRequest(serviceId, method, url);
  // Re-check the stored grant: a tampered row (e.g. broader scopes) is never used.
  const row = one<{ scopes: string }>(ctx.db, "SELECT scopes FROM oauth_connections WHERE service_id = ?", serviceId);
  const stored = row ? (JSON.parse(row.scopes) as string[]).filter((sc) => !["openid", "email", "profile"].includes(sc)).sort() : [];
  if (JSON.stringify(stored) !== JSON.stringify([...SCOPES[serviceId]].sort())) {
    throw new GoogleError(`Refusing to use ${serviceId}: stored scopes don't match the expected grant`, "SCOPE");
  }
  const token = await accessToken(ctx, serviceId, fetcher);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  return guardedFetch(fetcher)(url, { method, headers, body });
}

async function api<T>(ctx: Ctx, serviceId: GoogleServiceId, url: string, fetcher: Fetcher): Promise<T> {
  const res = await authedRequest(ctx, serviceId, "GET", url, fetcher);
  if (!res.ok) throw new GoogleError(`Google API returned HTTP ${res.status}`, "API");
  return (await res.json()) as T;
}

/** Base of the Gmail API for the signed-in user (kept here: only this connector names Google hosts). */
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Read-only Gmail GET, through the same allowlist and scope checks as every other call. */
export function gmailGet<T>(ctx: Ctx, url: string, fetcher: Fetcher = fetch): Promise<T> {
  return api<T>(ctx, "gmail", url, fetcher);
}

export function header(headers: { name: string; value: string }[] | undefined, name: string) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export const AUTOMATED = /(no-?reply|do-?not-?reply|notifications?|mailer-daemon|newsletter)@/i;

/** Gmail: the 25 most recent inbox messages, headers only. */
export async function syncGmail(ctx: Ctx, fetcher: Fetcher = fetch) {
  const list = await api<{ messages?: { id: string }[] }>(ctx, "gmail", "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=25", fetcher);
  const rows: { id: string; sender: string; subject: string; received_at: string; needs_reply: number; thread_id: string | null; rfc_message_id: string | null }[] = [];
  for (const m of list.messages ?? []) {
    if (!/^[\w-]{1,64}$/.test(m.id)) continue;
    const msg = await api<{ id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(
      ctx,
      "gmail",
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`,
      fetcher,
    );
    const from = header(msg.payload?.headers, "From").slice(0, 200);
    const labels = new Set(msg.labelIds ?? []);
    const bulk = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"].some((l) => labels.has(l));
    rows.push({
      id: `gm_${m.id}`,
      sender: from || "(unknown sender)",
      subject: header(msg.payload?.headers, "Subject").slice(0, 300) || "(no subject)",
      received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : ctx.now().toISOString(),
      needs_reply: labels.has("UNREAD") && !bulk && !AUTOMATED.test(from) ? 1 : 0,
      // Kept only so an approved reply draft lands in the right thread.
      thread_id: msg.threadId && /^[\w-]{1,64}$/.test(msg.threadId) ? msg.threadId : null,
      rfc_message_id: header(msg.payload?.headers, "Message-ID").match(/^<[^<>\s]{3,250}>$/)?.[0] ?? null,
    });
  }
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM messages WHERE source = 'gmail'");
    for (const r of rows) {
      // snippet stays empty on purpose: bodies are never requested or stored.
      run(
        ctx.db,
        "INSERT INTO messages (id, sender, subject, snippet, received_at, needs_reply, is_demo, source, thread_id, rfc_message_id) VALUES (?, ?, ?, '', ?, ?, 0, 'gmail', ?, ?)",
        r.id,
        r.sender,
        r.subject,
        r.received_at,
        r.needs_reply,
        r.thread_id,
        r.rfc_message_id,
      );
    }
    run(ctx.db, "UPDATE oauth_connections SET last_sync_at = ?, last_sync_status = 'ok' WHERE service_id = 'gmail'", ctx.now().toISOString());
    run(ctx.db, "UPDATE services SET last_sync_at = ? WHERE id = 'gmail'", ctx.now().toISOString());
  });
  logActivity(ctx, { actor: "inbox", kind: "data_access", serviceId: "gmail", outcome: "ok", summary: `Synced ${rows.length} Gmail message headers (no bodies)` });
  return { messages: rows.length };
}

/** Calendar: primary calendar, yesterday to 14 days ahead. */
export async function syncCalendar(ctx: Ctx, fetcher: Fetcher = fetch) {
  const now = ctx.now();
  const params = new URLSearchParams({
    timeMin: new Date(now.getTime() - 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
    fields: "summary,items(id,status,summary,location,start,end)",
  });
  const res = await api<{ summary?: string; items?: { id: string; status?: string; summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[] }>(
    ctx,
    "google-calendar",
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    fetcher,
  );
  const toIso = (t?: { dateTime?: string; date?: string }) => (t?.dateTime ? new Date(t.dateTime).toISOString() : t?.date ? new Date(`${t.date}T00:00:00`).toISOString() : null);
  const items = (res.items ?? []).filter((e) => e.status !== "cancelled" && toIso(e.start));
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM events WHERE source = 'google-calendar'");
    for (const e of items) {
      run(
        ctx.db,
        "INSERT INTO events (id, title, starts_at, ends_at, location, is_demo, source) VALUES (?, ?, ?, ?, ?, 0, 'google-calendar')",
        `gc_${e.id.slice(0, 80)}`,
        (e.summary ?? "(no title)").slice(0, 200),
        toIso(e.start)!,
        toIso(e.end) ?? toIso(e.start)!,
        e.location?.slice(0, 200) ?? null,
      );
    }
    run(ctx.db, "UPDATE oauth_connections SET account = ?, last_sync_at = ?, last_sync_status = 'ok' WHERE service_id = 'google-calendar'", res.summary?.slice(0, 120) ?? null, ctx.now().toISOString());
    run(ctx.db, "UPDATE services SET last_sync_at = ? WHERE id = 'google-calendar'", ctx.now().toISOString());
  });
  logActivity(ctx, { actor: "calendar", kind: "data_access", serviceId: "google-calendar", outcome: "ok", summary: `Synced ${items.length} Google Calendar events (titles and times only)` });
  return { events: items.length };
}

/**
 * Events in any window up to 3 months (for "what's on 20 December?"), read-only and not stored:
 * the synced copy only covers yesterday to two weeks ahead.
 */
export async function fetchCalendarRange(ctx: Ctx, from: Date, to: Date, fetcher: Fetcher = fetch) {
  const end = new Date(Math.min(to.getTime(), from.getTime() + 92 * 86_400_000));
  const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100", fields: "items(id,status,summary,location,start,end)" });
  const res = await api<{ items?: { id: string; status?: string; summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[] }>(
    ctx,
    "google-calendar",
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    fetcher,
  );
  const toIso = (t?: { dateTime?: string; date?: string }) => (t?.dateTime ? new Date(t.dateTime).toISOString() : t?.date ? new Date(`${t.date}T00:00:00`).toISOString() : null);
  return (res.items ?? [])
    .filter((e) => e.status !== "cancelled" && toIso(e.start))
    .map((e) => ({ id: `gc_${e.id.slice(0, 80)}`, title: (e.summary ?? "(no title)").slice(0, 200), starts_at: toIso(e.start)!, ends_at: toIso(e.end) ?? toIso(e.start)!, location: e.location?.slice(0, 200) ?? null, allDay: !e.start?.dateTime }));
}

/** Revoke at Google, delete the token and every synced row, and mark the service revoked locally. */
export async function disconnectGoogle(ctx: Ctx, serviceId: GoogleServiceId, fetcher: Fetcher = fetch, reason = "Disconnected by you") {
  let token: StoredToken | undefined;
  try {
    token = loadToken(ctx, serviceId);
  } catch {
    // no stored token (never connected, or key missing): still clean up local state
  }
  if (token) await revoke(token.refresh_token ?? token.access_token, fetcher);
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM oauth_connections WHERE service_id = ?", serviceId);
    if (serviceId === "gmail") {
      run(ctx.db, "DELETE FROM messages WHERE source = 'gmail'");
      // Everything derived from Gmail headers goes too: inbox insights and the scan times.
      for (const t of ["waiting_on", "bookings", "subscriptions", "revived_threads"]) run(ctx.db, `DELETE FROM ${t} WHERE is_demo = 0`);
      run(ctx.db, "DELETE FROM settings WHERE key LIKE 'insights.scanned.%'");
      run(ctx.db, "DELETE FROM notifications_sent WHERE kind IN ('waiting', 'booking')");
    }
    if (serviceId === "google-calendar") run(ctx.db, "DELETE FROM events WHERE source = 'google-calendar'");
    // The app calendar and its events stay in your Google account; only the local copies go.
    if (serviceId === "google-calendar-app") run(ctx.db, "DELETE FROM events WHERE source = 'google-calendar-app'");
    // gmail-drafts keeps no synced data; drafts already created stay in your Gmail.
  });
  disconnectService(ctx, serviceId);
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId, outcome: "info", summary: `${reason}: token revoked at Google and deleted, synced data removed` });
}

export function connectionInfo(ctx: Ctx) {
  return all<{ service_id: string; account: string | null; scopes: string; connected_at: string; last_sync_at: string | null; last_sync_status: string | null }>(
    ctx.db,
    "SELECT service_id, account, scopes, connected_at, last_sync_at, last_sync_status FROM oauth_connections",
  ).map((r) => {
    const scopes = JSON.parse(r.scopes) as string[];
    const expected = isGoogleService(r.service_id) ? SCOPES[r.service_id] : [];
    // e.g. a Gmail connection made before the switch to gmail.readonly: usable only after reconnecting.
    const needsReconnect = JSON.stringify([...scopes].sort()) !== JSON.stringify([...expected].sort());
    return { ...r, scopes, needsReconnect };
  });
}

/** Extracts readable text from a Gmail message payload: text/plain preferred, else HTML stripped. */
export function extractText(payload: GmailPart | undefined, max = 4000): string {
  const decode = (data?: string) => (data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "");
  const parts: GmailPart[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    parts.push(p);
    p.parts?.forEach(walk);
  };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  let text = plain ? decode(plain.body?.data) : "";
  if (!text) {
    const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    text = html
      ? decode(html.body?.data)
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<br\s*\/?>|<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
      : "";
  }
  // Drop quoted history ("On … wrote:" and "> " lines) — the new part is what matters.
  text = text.split(/\n(?:On .{5,200} wrote:|Le .{5,200} a écrit\s?:|-{2,} ?Original Message ?-{2,})/)[0];
  text = text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/**
 * Reads ONE message's text, on demand. Nothing is stored: the caller uses it (a local LLM) and
 * drops it. Read-only by scope and by the request allowlist.
 */
export async function readMessageText(ctx: Ctx, localId: string, fetcher: Fetcher = fetch): Promise<{ text: string; sender: string; subject: string }> {
  const row = one<{ id: string; sender: string; subject: string }>(ctx.db, "SELECT id, sender, subject FROM messages WHERE id = ? AND source = 'gmail'", localId);
  if (!row) throw new GoogleError("Unknown Gmail message", "API");
  const gmailId = row.id.replace(/^gm_/, "");
  if (!/^[\w-]{1,64}$/.test(gmailId)) throw new GoogleError("Invalid message id", "API");
  const msg = await api<{ payload?: GmailPart }>(ctx, "gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=full`, fetcher);
  return { text: extractText(msg.payload), sender: row.sender, subject: row.subject };
}

export interface GmailHeaderRow {
  id: string;
  threadId: string | null;
  sender: string;
  to: string;
  subject: string;
  date: string;
  labels: string[];
  /** Mailing lists and newsletters carry an unsubscribe header. */
  bulk: boolean;
  /** RFC 2822 Message-ID, so a reply draft lands in the right thread. */
  messageId: string | null;
}

const GMAIL_ID = /^[\w-]{1,64}$/;
const headerRow = (m: { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }, now: Date): GmailHeaderRow => {
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    threadId: m.threadId && GMAIL_ID.test(m.threadId) ? m.threadId : null,
    sender: header(m.payload?.headers, "From").slice(0, 200) || "(unknown sender)",
    to: header(m.payload?.headers, "To").slice(0, 200),
    subject: header(m.payload?.headers, "Subject").slice(0, 300) || "(no subject)",
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : now.toISOString(),
    labels,
    bulk: Boolean(header(m.payload?.headers, "List-Unsubscribe")) || ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"].some((l) => labels.includes(l)),
    messageId: header(m.payload?.headers, "Message-ID").match(/^<[^<>\s]{3,250}>$/)?.[0] ?? null,
  };
};

/**
 * Gmail's own search (the same query syntax as the Gmail search box), headers only, newest first.
 * Read-only: GET /messages?q=… then GET /messages/{id}?format=metadata. Nothing is stored.
 */
export async function searchGmail(ctx: Ctx, query: string, max = 20, fetcher: Fetcher = fetch): Promise<GmailHeaderRow[]> {
  const params = new URLSearchParams({ q: query.slice(0, 300), maxResults: String(Math.min(Math.max(max, 1), 50)) });
  const list = await api<{ messages?: { id: string }[] }>(ctx, "gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, fetcher);
  const ids = (list.messages ?? []).map((m) => m.id).filter((id) => GMAIL_ID.test(id));
  const rows: GmailHeaderRow[] = [];
  for (const id of ids) {
    const m = await api<{ id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(
      ctx,
      "gmail",
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=Message-ID`,
      fetcher,
    );
    rows.push(headerRow(m, ctx.now()));
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/** One message's headers and text, read on demand for the local model. The text is untrusted and never stored. */
export async function readGmailById(ctx: Ctx, gmailId: string, fetcher: Fetcher = fetch): Promise<GmailHeaderRow & { text: string }> {
  if (!GMAIL_ID.test(gmailId)) throw new GoogleError("Invalid message id", "API");
  const m = await api<{ id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } }>(
    ctx,
    "gmail",
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=full`,
    fetcher,
  );
  return { ...headerRow(m, ctx.now()), text: extractText(m.payload) };
}

// ---- Gmail drafts: the single write path ----

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeader(value: string) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Builds the RFC 2822 message for a draft. Header values cannot contain CR/LF (no header
 * injection); the body is base64-encoded UTF-8 plain text.
 */
export function buildDraftMime(d: DraftInput): string {
  for (const [k, v] of Object.entries({ to: d.to, subject: d.subject, inReplyTo: d.inReplyTo ?? "" })) {
    if (/[\r\n]/.test(v)) throw new GoogleError(`Invalid ${k}: line breaks are not allowed in headers`, "API");
  }
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(d.to)) throw new GoogleError("Invalid recipient address", "API");
  const headers = [
    `To: ${d.to}`,
    `Subject: ${encodeHeader(d.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (d.inReplyTo) headers.push(`In-Reply-To: ${d.inReplyTo}`, `References: ${d.inReplyTo}`);
  const body = Buffer.from(d.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Creates ONE draft. This is the only call the gmail-drafts token can make in this codebase. */
export const MAX_DRAFTS_PER_DAY = 20;

export async function createGmailDraft(ctx: Ctx, d: DraftInput, fetcher: Fetcher = fetch): Promise<{ draftId: string }> {
  // Circuit breaker: even with approvals, never more than N drafts a day.
  const since = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const today = one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM actions WHERE service_id = 'gmail-drafts' AND status = 'executed' AND executed_at >= ?", since)?.n ?? 0;
  if (today >= MAX_DRAFTS_PER_DAY) throw new GoogleError(`Daily limit of ${MAX_DRAFTS_PER_DAY} Gmail drafts reached`, "API");
  const raw = Buffer.from(buildDraftMime(d), "utf8").toString("base64url");
  const body = JSON.stringify({ message: { raw, ...(d.threadId && /^[\w-]{1,64}$/.test(d.threadId) ? { threadId: d.threadId } : {}) } });
  const res = await authedRequest(ctx, "gmail-drafts", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts", fetcher, body);
  if (!res.ok) throw new GoogleError(`Gmail refused the draft (HTTP ${res.status})`, "API");
  const out = (await res.json()) as { id?: string };
  run(ctx.db, "UPDATE services SET last_sync_at = ? WHERE id = 'gmail-drafts'", ctx.now().toISOString());
  return { draftId: String(out.id ?? "") };
}

// ---------------------------------------------------------------------------------------------
// The app's own calendar (option "the app creates events"): calendar.app.created scope only.

export const APP_CALENDAR_NAME = "Agent Command Center";
export const MAX_APP_EVENTS_PER_DAY = 20;
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";

/** The app calendar's id, creating the calendar the first time. */
const APP_CALENDAR_ID = /^[\w.-]{1,100}@group\.calendar\.google\.com$/;

async function ensureAppCalendar(ctx: Ctx, timeZone: string, fetcher: Fetcher): Promise<string> {
  const existing = getSetting(ctx.db, "gcal.app.calendarId");
  // A stored id that isn't a secondary-calendar id (tampered or corrupt) is ignored, never used.
  if (existing && APP_CALENDAR_ID.test(existing)) return existing;
  const body = JSON.stringify({ summary: APP_CALENDAR_NAME, description: "Events you approved in Agent Command Center. The app can only reach this calendar.", timeZone });
  const res = await authedRequest(ctx, "google-calendar-app", "POST", CALENDAR_API, fetcher, body);
  if (!res.ok) throw new GoogleError(`Google refused to create the app calendar (HTTP ${res.status})`, "API");
  const id = String(((await res.json()) as { id?: string }).id ?? "");
  if (!APP_CALENDAR_ID.test(id)) throw new GoogleError("Google returned an unexpected calendar id", "API");
  setSetting(ctx.db, "gcal.app.calendarId", id);
  return id;
}

export interface AppEventInput {
  /** Stable per approved action, so a retried execution never creates a duplicate. */
  idempotencyId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  location?: string;
  timeZone: string;
}

/** Creates one approved event in the app calendar (and a local copy for the agenda). */
export async function createAppCalendarEvent(ctx: Ctx, e: AppEventInput, fetcher: Fetcher = fetch): Promise<{ eventId: string; calendar: string }> {
  const since = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const today = one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM actions WHERE service_id = 'google-calendar-app' AND status = 'executed' AND executed_at >= ?", since)?.n ?? 0;
  if (today >= MAX_APP_EVENTS_PER_DAY) throw new GoogleError(`Daily limit of ${MAX_APP_EVENTS_PER_DAY} calendar events reached`, "API");
  // Google event ids are base32hex (0-9, a-v); a sha256 hex digest fits.
  const eventId = createHash("sha256").update(e.idempotencyId).digest("hex").slice(0, 32);
  const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: e.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const when = e.allDay
    ? { start: { date: localDate(e.startsAt) }, end: { date: localDate(e.endsAt) } }
    : { start: { dateTime: e.startsAt, timeZone: e.timeZone }, end: { dateTime: e.endsAt, timeZone: e.timeZone } };
  const body = JSON.stringify({ id: eventId, summary: e.title, ...(e.location ? { location: e.location } : {}), description: "Added by Agent Command Center after your approval.", ...when });
  for (let attempt = 0; attempt < 2; attempt++) {
    const calendarId = await ensureAppCalendar(ctx, e.timeZone, fetcher);
    const res = await authedRequest(ctx, "google-calendar-app", "POST", `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events`, fetcher, body);
    if (res.status === 404 && attempt === 0) {
      run(ctx.db, "DELETE FROM settings WHERE key = 'gcal.app.calendarId'"); // calendar deleted in Google: make a new one
      continue;
    }
    // 409 = this event id already exists: an earlier attempt succeeded, so this one is a no-op.
    if (!res.ok && res.status !== 409) throw new GoogleError(`Google Calendar refused the event (HTTP ${res.status})`, "API");
    run(ctx.db, "INSERT OR REPLACE INTO events (id, title, starts_at, ends_at, location, is_demo, source) VALUES (?, ?, ?, ?, ?, 0, 'google-calendar-app')", `gca_${eventId}`, e.title.slice(0, 200), e.startsAt, e.endsAt, e.location?.slice(0, 200) ?? null);
    run(ctx.db, "UPDATE services SET last_sync_at = ? WHERE id = 'google-calendar-app'", ctx.now().toISOString());
    return { eventId, calendar: APP_CALENDAR_NAME };
  }
  throw new GoogleError("The app calendar could not be found or recreated", "API");
}

/** Undo of an autopilot event: removes that event from the app calendar (and the local copy). 404/410 = already gone. */
export async function deleteAppCalendarEvent(ctx: Ctx, idempotencyId: string, fetcher: Fetcher = fetch): Promise<void> {
  const calendarId = getSetting(ctx.db, "gcal.app.calendarId");
  if (!calendarId || !APP_CALENDAR_ID.test(calendarId)) throw new GoogleError("The app calendar isn't set up", "API");
  const eventId = createHash("sha256").update(idempotencyId).digest("hex").slice(0, 32);
  const res = await authedRequest(ctx, "google-calendar-app", "DELETE", `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events/${eventId}`, fetcher);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new GoogleError(`Google Calendar refused to remove the event (HTTP ${res.status})`, "API");
  run(ctx.db, "DELETE FROM events WHERE id = ?", `gca_${eventId}`);
}

/** Undo of an autopilot draft: deletes that draft from Gmail Drafts. 404 = already gone (sent or deleted by you). */
export async function deleteGmailDraft(ctx: Ctx, draftId: string, fetcher: Fetcher = fetch): Promise<void> {
  if (!/^[\w-]{1,64}$/.test(draftId)) throw new GoogleError("Unexpected draft id", "API");
  const res = await authedRequest(ctx, "gmail-drafts", "DELETE", `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`, fetcher);
  if (!res.ok && res.status !== 404) throw new GoogleError(`Gmail refused to remove the draft (HTTP ${res.status})`, "API");
}

