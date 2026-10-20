import { ZodError } from "zod";
import { ModeError } from "./mode";
import { connection } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { PolicyError } from "./policy/engine";
import { ApprovalError } from "./approvals";
import { PermissionChangeError } from "./policy/permissions";
import { SchedulerError } from "./scheduler/scheduler";
import { CsvError } from "./csv";
import { ToolInputError } from "./tools/registry";
import { getCtx } from "./runtime";
import { VoyageRateLimitError } from "./retrieval/embeddings";
import { LlmUnavailableError } from "./llm";
import type { Ctx } from "./db";
import { UserError } from "./errors";
import { RequestCancelledError } from "./requestScope";

/**
 * Request guard for every API route.
 *
 * This is a single-user app meant to listen on 127.0.0.1 only. The guard adds:
 *  - Host allowlist (defeats DNS-rebinding attacks from web pages on other origins);
 *  - for mutations: same-origin check + JSON content type + a custom header, so a
 *    cross-site form or fetch cannot trigger state changes (CSRF);
 *  - a body size limit and simple in-memory rate limits for expensive operations.
 * It is NOT user authentication. Exposing the app beyond localhost needs real auth first.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY = 300_000;

/** Strips connection strings, bearer tokens and key-like values before anything reaches a log. */
export function redactSecrets(message: string): string {
  return message
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://[redacted]")
    .replace(/(bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|client_secret|refresh_token|access_token)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1[redacted]")
    .slice(0, 500);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function hostnameOf(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

export function checkRequest(req: Request, mutating: boolean) {
  const host = req.headers.get("host");
  const hostname = hostnameOf(host);
  if (!hostname || !LOCAL_HOSTS.has(hostname)) throw new HttpError(403, "This dashboard only accepts requests addressed to localhost.");
  if (!mutating) return;
  const origin = req.headers.get("origin");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null; // "null" or garbage → refused below
  } catch {
    originHost = null;
  }
  if (!originHost || originHost !== host) throw new HttpError(403, "Cross-origin request refused.");
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "Expected application/json.");
  if (req.headers.get("x-acc-request") !== "1") throw new HttpError(403, "Missing request header.");
}

export async function readJson(req: Request, maxBytes = MAX_BODY): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "Request body too large.");
  // Enforce the cap while streaming, so a body without (or with a lying) content-length can't
  // make the server buffer an arbitrary amount of data.
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new HttpError(413, "Request body too large.");
      chunks.push(chunk);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

const buckets = new Map<string, { tokens: number; at: number }>();
/** Token bucket per operation name: `perMinute` requests, refilled continuously. */
export function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) throw new HttpError(429, "Too many requests — slow down a little.");
  b.tokens -= 1;
  buckets.set(key, b);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError || err instanceof UserError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ModeError) return Response.json({ error: err.message, code: err.code }, { status: 403 });
  if (err instanceof PolicyError) return Response.json({ error: err.message, code: err.code }, { status: 403 });
  if (err instanceof ApprovalError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "NOT_FOUND" ? 404 : 409 });
  if (err instanceof PermissionChangeError || err instanceof SchedulerError || err instanceof CsvError || err instanceof ToolInputError) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof RequestCancelledError) return Response.json({ error: err.message, code: "CANCELLED" }, { status: 499 });
  if (err instanceof LlmUnavailableError) return Response.json({ error: err.message, code: err.code }, { status: 503 });
  if (err instanceof VoyageRateLimitError) return Response.json({ error: err.message, code: err.code, retryInSeconds: err.retryInSeconds }, { status: 429 });
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return Response.json({ error: `Invalid request: ${where}${issue?.message ?? "invalid input"}` }, { status: 400 });
  }
  // Unknown errors: log server-side, return a generic message (no stack traces or internals).
  console.error("[api] unhandled error:", redactSecrets(err instanceof Error ? err.message : String(err)));
  const message = err instanceof Error && /not configured|not installed|live mode is off|unavailable|Live retrieval failed/i.test(err.message) ? err.message : "Something went wrong. Check the server log.";
  return Response.json({ error: message }, { status: 500 });
}

/** Wraps a route body with the guard and error mapping. */
export function handler(mutating: boolean, fn: (req: Request, ctx: Ctx) => Promise<unknown>) {
  return async (req: Request) => {
    // Every API response depends on live local state: never prerender or cache it.
    await connection();
    try {
      checkRequest(req, mutating);
      const result = await fn(req, getCtx());
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      unstable_rethrow(err);
      return errorResponse(err);
    }
  };
}
