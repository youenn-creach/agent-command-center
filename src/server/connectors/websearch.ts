import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { cleanText, safeAgent, validateFeedUrl } from "../news/feeds";

/**
 * Web search through the user's own SearXNG on this computer (http://127.0.0.1:8888, or ACC_SEARXNG_URL;
 * loopback only). SearXNG forwards the query to public search engines without an account or cookies, so
 * no search profile is built. The top pages can then be read: https and public addresses only (the same
 * connect-time guard as news feeds), redirects re-checked, 1 MB cap, HTML stripped. Everything returned
 * is untrusted data and only reaches the model fenced as such.
 */

export class WebSearchError extends Error {}

export interface WebResult {
  n: number;
  title: string;
  url: string;
  snippet: string;
}

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

function searxBase(): URL {
  const base = new URL(process.env.ACC_SEARXNG_URL ?? "http://127.0.0.1:8888");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new WebSearchError("The search service must run on this computer (ACC_SEARXNG_URL must be a loopback address).");
  return base;
}

/** The top results for a query, in SearXNG's order, without duplicates. */
export async function searchWeb(query: string, fetcher: Fetcher = (url, init) => fetch(url, { ...init, redirect: "error" })): Promise<WebResult[]> {
  const q = z.string().trim().min(2).max(200).parse(query);
  const url = new URL("/search", searxBase());
  url.search = new URLSearchParams({ q, format: "json", language: "en", safesearch: "0" }).toString();
  let res: Response;
  try {
    res = await fetcher(url.toString(), { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new WebSearchError("The private search service (SearXNG) isn't answering on this computer. Start it with: systemctl --user start acc-searxng");
  }
  if (!res.ok) throw new WebSearchError(`The search service returned HTTP ${res.status}.`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  const seen = new Set<string>();
  const out: WebResult[] = [];
  for (const r of data.results ?? []) {
    if (!r.url || !/^https?:\/\//i.test(r.url) || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ n: out.length + 1, title: cleanText(r.title ?? r.url, 200), url: r.url.slice(0, 500), snippet: cleanText(r.content ?? "", 400) });
    if (out.length === 8) break;
  }
  return out;
}

/** The readable text of one public https page (main or article content when marked), at most `max` characters. */
export async function readPage(raw: string, max = 3000): Promise<string> {
  let url = validateFeedUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await undiciFetch(url, {
      dispatcher: safeAgent,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "agent-command-center/0.1 (personal assistant)", accept: "text/html, text/plain;q=0.9" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new WebSearchError(`Redirect without location (HTTP ${res.status})`);
      url = validateFeedUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new WebSearchError(`The page returned HTTP ${res.status}`);
    if (!/text\/(html|plain)/i.test(res.headers.get("content-type") ?? "")) throw new WebSearchError("Not a web page");
    if (!res.body) throw new WebSearchError("Empty page");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_PAGE_BYTES) break; // the start of a long page is enough
      chunks.push(chunk);
    }
    return pageText(Buffer.concat(chunks).toString("utf8"), max);
  }
  throw new WebSearchError("Too many redirects");
}

/** Text of an HTML page without navigation, headers, footers and scripts; the main/article part when there is one. */
export function pageText(html: string, max: number): string {
  const main = html.match(/<(main|article)\b[\s\S]*?<\/\1>/i)?.[0] ?? html;
  return cleanText(main.replace(/<(nav|header|footer|aside|form|noscript|svg)\b[\s\S]*?<\/\1>/gi, " "), max);
}
