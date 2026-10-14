import { connection } from "next/server";
import { checkRequest, redactSecrets } from "@/server/http";
import { getCtx } from "@/server/runtime";
import { GoogleError, handleCallback } from "@/server/connectors/google";

/**
 * Google redirects the browser here after consent. Protection comes from the one-time `state`
 * (bound to a PKCE verifier) rather than the same-origin checks used by the JSON API, because this
 * is a top-level navigation from accounts.google.com. Only a short status code is put in the URL.
 */
export async function GET(req: Request) {
  await connection();
  const back = (query: string) =>
    new Response(null, { status: 303, headers: { location: `/?${query}#permissions`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  try {
    checkRequest(req, false);
    const url = new URL(req.url);
    const service = await handleCallback(getCtx(), { code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") });
    return back(`connected=${service}`);
  } catch (err) {
    const code = err instanceof GoogleError ? err.code : "ERROR";
    if (!(err instanceof GoogleError)) console.error("[oauth] callback failed:", redactSecrets(err instanceof Error ? err.message : String(err)));
    return back(`oauth_error=${encodeURIComponent(code)}`);
  }
}
