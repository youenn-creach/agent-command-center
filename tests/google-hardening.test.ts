import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertAllowedGoogleRequest } from "@/server/connectors/google";

/**
 * Guarantees that the app cannot modify Gmail or Google Calendar beyond creating an approved draft.
 * These tests fail the build if a write endpoint is ever added.
 */

describe("Google request allowlist (the only requests a token may make)", () => {
  it.each([
    ["gmail", "GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=25"],
    ["gmail", "GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=metadata"],
    ["google-calendar", "GET", "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true"],
    ["gmail-drafts", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts"],
  ] as const)("allows %s %s", (svc, method, url) => {
    expect(() => assertAllowedGoogleRequest(svc, method, url)).not.toThrow();
  });

  it.each([
    // sending, by every route
    ["gmail-drafts", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"],
    ["gmail-drafts", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send"],
    ["gmail-drafts", "POST", "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send"],
    // modifying / deleting mail
    ["gmail", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/modify"],
    ["gmail", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/trash"],
    ["gmail", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify"],
    ["gmail", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchDelete"],
    ["gmail", "GET", "https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses"],
    ["gmail", "GET", "https://gmail.googleapis.com/gmail/v1/users/other@example.com/messages"],
    // drafts token can't read or update drafts, and can delete only one draft by id (Undo of autopilot)
    ["gmail-drafts", "GET", "https://gmail.googleapis.com/gmail/v1/users/me/drafts"],
    ["gmail-drafts", "GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ["gmail-drafts", "DELETE", "https://gmail.googleapis.com/gmail/v1/users/me/drafts"],
    ["gmail-drafts", "DELETE", "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc"],
    ["gmail-drafts", "PUT", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/abc"],
    ["gmail", "DELETE", "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc"],
    ["gmail", "DELETE", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/abc"],
    // deleting in calendars: never the main calendar, never a calendar itself, never an event id the app didn't make
    ["google-calendar", "DELETE", "https://www.googleapis.com/calendar/v3/calendars/primary/events/0123456789abcdef0123456789abcdef"],
    ["google-calendar-app", "DELETE", "https://www.googleapis.com/calendar/v3/calendars/primary/events/0123456789abcdef0123456789abcdef"],
    ["google-calendar-app", "DELETE", "https://www.googleapis.com/calendar/v3/calendars/acc%40group.calendar.google.com"],
    ["google-calendar-app", "DELETE", "https://www.googleapis.com/calendar/v3/calendars/acc%40group.calendar.google.com/events/someone-elses-event"],
    ["google-calendar-app", "PATCH", "https://www.googleapis.com/calendar/v3/calendars/acc%40group.calendar.google.com/events/0123456789abcdef0123456789abcdef"],
    // calendar writes
    ["google-calendar", "POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events"],
    ["google-calendar", "GET", "https://www.googleapis.com/calendar/v3/calendars/primary/events/abc"],
    ["google-calendar", "GET", "https://www.googleapis.com/calendar/v3/users/me/calendarList"],
    // wrong host / scheme
    ["gmail", "GET", "http://gmail.googleapis.com/gmail/v1/users/me/messages"],
    ["google-calendar", "GET", "https://evil.example.com/calendar/v3/calendars/primary/events"],
  ] as const)("blocks %s %s %s", (svc, method, url) => {
    expect(() => assertAllowedGoogleRequest(svc, method, url)).toThrow(/Blocked/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx|mts)$/.test(f) ? [p] : [];
  });
}

describe("source scan", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];

  it("only the Google connector talks to Google APIs", () => {
    const talking = files.filter((f) => /googleapis\.com/.test(readFileSync(f, "utf8"))).map((f) => f.replaceAll("\\", "/"));
    // scripts/sim-gmail.ts is a FAKE Gmail for the simulations: it answers calls aimed at Google and never makes one.
    expect(talking.filter((f) => f !== "scripts/sim-gmail.ts")).toEqual(["src/server/connectors/google.ts"]);
  });

  it("deleting at Google exists only for Undo of autopilot: two calls, both in the Google connector", () => {
    const deletes = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/"DELETE"/g)].map(() => f.replaceAll("\\", "/")));
    // Calls (not the allowlist or the type of authedRequest): exactly the two Undo functions.
    expect(deletes.filter((f) => f !== "src/server/connectors/google.ts")).toEqual([]);
    const google = readFileSync("src/server/connectors/google.ts", "utf8");
    expect([...google.matchAll(/await authedRequest\([^)]*"DELETE"/g)].length).toBe(2);
    expect(google).toMatch(/export async function deleteAppCalendarEvent/);
    expect(google).toMatch(/export async function deleteGmailDraft/);
  });

  it("no Gmail send/modify/trash/delete or Calendar write endpoint appears anywhere in the code", () => {
    const forbidden = /(messages\/send|drafts\/send|\/modify\b|\/trash\b|batchModify|batchDelete|\/untrash|\/import\b|\/insert\b|calendars\/[^"'`]*\/events\/(?!\$)|quickAdd|settings\/(forwarding|filters|sendAs))/;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // The allowlist regexes and comments describe endpoints; strip comments before scanning.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const hit = code.match(forbidden);
      expect(hit, `${f} mentions a Google write endpoint: ${hit?.[0]}`).toBeNull();
    }
  });
});
