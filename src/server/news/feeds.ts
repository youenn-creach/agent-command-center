import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { all, newId, one, run, tx, type Ctx } from "../db";
import { logActivity } from "../activity";

/**
 * Public RSS/Atom feeds for the morning briefing.
 *
 * Fetching a user-supplied URL from a server is a classic SSRF risk, so:
 *  - https only, default port, no credentials in the URL, no IP-literal hosts;
 *  - every address the hostname resolves to is checked AT CONNECT TIME (custom DNS lookup on the
 *    HTTP agent), so private, loopback, link-local and metadata addresses are refused even if DNS
 *    changes between checks (DNS rebinding);
 *  - redirects are followed manually (max 3), re-validating each hop;
 *  - 10 s timeout, 1.5 MB size cap, XML only, DTD/entity declarations refused;
 *  - feed text is untrusted data: HTML is stripped, length capped, and it only ever reaches the
 *    LLM fenced as data.
 */

export class FeedError extends Error {}

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const MAX_ITEMS_PER_SOURCE = 30;
const SUMMARY_CHARS = 400;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
  }
  return true; // not an IP at all: refuse
}

/** https on the default port, no credentials, a real public hostname. Used for feeds and webhooks. */
export function validateFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError("Not a valid URL");
  }
  if (url.protocol !== "https:") throw new FeedError("Only https:// feeds are allowed");
  if (url.username || url.password) throw new FeedError("URLs with credentials are not allowed");
  if (url.port && url.port !== "443") throw new FeedError("Only the default https port is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) throw new FeedError("Use a hostname, not an IP address");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new FeedError("Local or internal hostnames are not allowed");
  }
  if (raw.length > 500) throw new FeedError("URL is too long");
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup used for every outgoing feed connection: refuses if ANY resolved address is private. */
export function safeLookup(hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad || addresses.length === 0) {
      const e = new Error(`Refusing to connect: ${hostname} resolves to a private or reserved address`) as NodeJS.ErrnoException;
      e.code = "EPRIVATEADDR";
      return callback(e, []);
    }
    if (typeof options === "object" && options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** HTTP agent whose every connection goes through safeLookup. Shared by feeds and webhooks. */
export const safeAgent = new Agent({ connect: { lookup: safeLookup as never, timeout: 10_000 }, headersTimeout: 10_000, bodyTimeout: 10_000 });
const agent = safeAgent;

export async function fetchFeedXml(raw: string): Promise<string> {
  let url = validateFeedUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await undiciFetch(url, {
      dispatcher: agent,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "agent-command-center/0.1 (personal RSS reader)", accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new FeedError(`Redirect without location (HTTP ${res.status})`);
      url = validateFeedUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new FeedError(`Feed returned HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/xml|rss|atom/i.test(type)) throw new FeedError(`Not a feed (content-type ${type.split(";")[0] || "missing"})`);
    if (!res.body) throw new FeedError("Empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new FeedError("Feed is larger than 1.5 MB");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new FeedError("Too many redirects");
}

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  return "";
}

export function cleanText(html: string, max = SUMMARY_CHARS): string {
  const plain = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function safeLink(v: string): string | null {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function isoDate(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Parses RSS 2.0 or Atom into plain items. Refuses DTDs/entity declarations (billion-laughs style payloads). */
export function parseFeed(xml: string): FeedItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FeedError("Feeds with DTD or entity declarations are refused");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true, htmlEntities: true, maxNestedTags: 50, isArray: (name) => ["item", "entry", "link"].includes(name) });
  const doc = parser.parse(xml) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const items: FeedItem[] = [];
  const rssItems = doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item;
  if (Array.isArray(rssItems)) {
    for (const it of rssItems) {
      const link = safeLink(text(Array.isArray(it.link) ? it.link[0] : it.link) || text(it.guid));
      const title = cleanText(text(it.title), 200);
      if (!link || !title) continue;
      items.push({ title, url: link, summary: cleanText(text(it.description) || text(it["content:encoded"])), publishedAt: isoDate(text(it.pubDate) || text(it["dc:date"])) });
    }
  } else if (Array.isArray(doc?.feed?.entry)) {
    for (const e of doc.feed.entry) {
      const links = (e.link ?? []) as Record<string, string>[];
      const href = (links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0])?.["@_href"];
      const link = href ? safeLink(href) : null;
      const title = cleanText(text(e.title), 200);
      if (!link || !title) continue;
      items.push({ title, url: link, summary: cleanText(text(e.summary) || text(e.content)), publishedAt: isoDate(text(e.published) || text(e.updated)) });
    }
  } else {
    throw new FeedError("Unrecognised feed format (expected RSS or Atom)");
  }
  return items;
}

// ---- sources and storage ----

export interface NewsSourceRow {
  id: string;
  name: string;
  url: string;
  enabled: number;
  last_fetch_at: string | null;
  last_status: string | null;
  item_count: number;
  created_at: string;
}

export const SUGGESTED_SOURCES = [
  { name: "Hacker News (front page)", url: "https://news.ycombinator.com/rss" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "Simon Willison's Weblog", url: "https://simonwillison.net/atom/everything/" },
];

export const SourceInputSchema = z.object({ name: z.string().trim().min(1).max(80), url: z.string().trim().min(10).max(500) });

export function seedSuggestedSources(ctx: Ctx) {
  // Suggestions are offered, never enabled automatically: fetching starts only when you switch a source on.
  for (const s of SUGGESTED_SOURCES) {
    run(ctx.db, "INSERT OR IGNORE INTO news_sources (id, name, url, enabled, created_at) VALUES (?, ?, ?, 0, ?)", newId("src"), s.name, s.url, ctx.now().toISOString());
  }
}

export function listSources(ctx: Ctx): NewsSourceRow[] {
  return all<NewsSourceRow>(ctx.db, "SELECT * FROM news_sources ORDER BY created_at, name");
}

export function addSource(ctx: Ctx, input: z.input<typeof SourceInputSchema>) {
  const { name, url } = SourceInputSchema.parse(input);
  const valid = validateFeedUrl(url).toString();
  if (listSources(ctx).length >= 10) throw new FeedError("Up to 10 sources — remove one first");
  run(ctx.db, "INSERT INTO news_sources (id, name, url, enabled, created_at) VALUES (?, ?, ?, 1, ?)", newId("src"), name, valid, ctx.now().toISOString());
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: "public-news", outcome: "info", summary: `Added news source ${name} (${new URL(valid).hostname})` });
}

export function setSourceEnabled(ctx: Ctx, id: string, enabled: boolean) {
  const src = one<NewsSourceRow>(ctx.db, "SELECT * FROM news_sources WHERE id = ?", id);
  if (!src) throw new FeedError("Unknown source");
  run(ctx.db, "UPDATE news_sources SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
  if (!enabled) run(ctx.db, "DELETE FROM news_items WHERE is_demo = 0 AND source = ?", src.name);
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: "public-news", outcome: "info", summary: `${enabled ? "Enabled" : "Disabled"} news source ${src.name}` });
}

export function removeSource(ctx: Ctx, id: string) {
  const src = one<NewsSourceRow>(ctx.db, "SELECT * FROM news_sources WHERE id = ?", id);
  if (!src) throw new FeedError("Unknown source");
  run(ctx.db, "DELETE FROM news_items WHERE is_demo = 0 AND source = ?", src.name);
  run(ctx.db, "DELETE FROM news_sources WHERE id = ?", id);
  logActivity(ctx, { actor: "user", kind: "connection_change", serviceId: "public-news", outcome: "info", summary: `Removed news source ${src.name}` });
}

/** Fetches every enabled source (sequentially, bounded) and stores fresh items as live (non-demo) news. */
export async function refreshFeeds(ctx: Ctx, fetcher: (url: string) => Promise<string> = fetchFeedXml) {
  const sources = listSources(ctx).filter((s) => s.enabled).slice(0, 10);
  const report: { source: string; ok: boolean; items: number; error?: string }[] = [];
  for (const s of sources) {
    try {
      const items = parseFeed(await fetcher(s.url)).slice(0, MAX_ITEMS_PER_SOURCE);
      tx(ctx.db, () => {
        run(ctx.db, "DELETE FROM news_items WHERE is_demo = 0 AND source = ?", s.name);
        for (const it of items) {
          run(
            ctx.db,
            "INSERT OR REPLACE INTO news_items (id, source, title, summary, url, published_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, 0)",
            `rss_${createHash("sha1").update(it.url).digest("hex").slice(0, 16)}`,
            s.name,
            it.title,
            it.summary,
            it.url,
            it.publishedAt,
          );
        }
        run(ctx.db, "UPDATE news_sources SET last_fetch_at = ?, last_status = 'ok', item_count = ? WHERE id = ?", ctx.now().toISOString(), items.length, s.id);
      });
      report.push({ source: s.name, ok: true, items: items.length });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 160);
      run(ctx.db, "UPDATE news_sources SET last_fetch_at = ?, last_status = ? WHERE id = ?", ctx.now().toISOString(), `error: ${message}`, s.id);
      report.push({ source: s.name, ok: false, items: 0, error: message });
    }
  }
  if (sources.length) {
    const ok = report.filter((r) => r.ok);
    logActivity(ctx, {
      actor: "knowledge",
      kind: "data_access",
      serviceId: "public-news",
      outcome: ok.length === report.length ? "ok" : ok.length ? "info" : "failed",
      summary: `Fetched ${ok.reduce((n, r) => n + r.items, 0)} items from ${ok.length}/${report.length} news source(s)`,
    });
  }
  return report;
}
