import { describe, expect, it } from "vitest";
import { addSource, FeedError, isPrivateAddress, listSources, parseFeed, refreshFeeds, safeLookup, setSourceEnabled, validateFeedUrl } from "@/server/news/feeds";
import { dailyBriefing } from "@/server/agents/chiefOfStaff";
import { callTool } from "@/server/tools/registry";
import { RunBudget } from "@/server/tools/budget";
import { all } from "@/server/db";
import { seededCtx, stubLlm } from "./helpers";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>First &amp; best</title><link>https://example.com/a</link><description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title>Atom post</title><link rel="alternate" href="https://example.org/post"/><summary>Short summary</summary><updated>2026-10-11T10:00:00Z</updated></entry>
</feed>`;

describe("feed URL validation (SSRF)", () => {
  it.each([
    "http://example.com/feed",
    "https://127.0.0.1/feed",
    "https://[::1]/feed",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/feed",
    "https://router.local/feed",
    "https://intranet/feed",
    "https://user:pw@example.com/feed",
    "https://example.com:8443/feed",
    "file:///etc/passwd",
  ])("refuses %s", (url) => {
    expect(() => validateFeedUrl(url)).toThrow(FeedError);
  });

  it("accepts a normal https feed", () => {
    expect(validateFeedUrl("https://news.ycombinator.com/rss").hostname).toBe("news.ycombinator.com");
  });

  it.each(["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("treats %s as public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it("refuses at connect time when a hostname resolves to a private address", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup("localhost", { all: true }, (e) => resolve(e)));
    expect(err?.code).toBe("EPRIVATEADDR");
  });
});

describe("feed parsing", () => {
  it("parses RSS, strips HTML and drops non-http links", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "First & best", url: "https://example.com/a", summary: "Hello world" });
    expect(items[0].publishedAt).toBe("2026-10-12T08:00:00.000Z");
  });

  it("parses Atom", () => {
    expect(parseFeed(ATOM)[0]).toMatchObject({ title: "Atom post", url: "https://example.org/post", summary: "Short summary" });
  });

  it("refuses DTD / entity declarations", () => {
    expect(() => parseFeed(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel></channel></rss>`)).toThrow(/DTD/);
  });

  it("refuses non-feed XML", () => {
    expect(() => parseFeed("<html><body>hi</body></html>")).toThrow(/Unrecognised/);
  });
});

describe("sources and the briefing", () => {
  it("offers suggestions disabled by default — nothing is fetched until you enable one", async () => {
    const ctx = seededCtx();
    expect(listSources(ctx).length).toBeGreaterThan(0);
    expect(listSources(ctx).every((s) => !s.enabled)).toBe(true);
    let calls = 0;
    await refreshFeeds(ctx, async () => {
      calls++;
      return RSS;
    });
    expect(calls).toBe(0);
  });

  it("refuses to add an unsafe source", () => {
    const ctx = seededCtx();
    expect(() => addSource(ctx, { name: "metadata", url: "https://169.254.169.254/feed" })).toThrow(FeedError);
  });

  it("uses live items when available and marks the briefing as live", async () => {
    const ctx = seededCtx();
    setSourceEnabled(ctx, listSources(ctx)[0].id, true);
    await refreshFeeds(ctx, async () => RSS);
    const items = await callTool(ctx, "knowledge", "news.list_items", { limit: 5 }, new RunBudget(3, 5000));
    expect(items.every((i) => i.is_demo === 0)).toBe(true);
    const out = await dailyBriefing(ctx, null, stubLlm("digest"));
    const brief = all<{ provenance: string }>(ctx.db, "SELECT provenance FROM briefings WHERE id = ?", out.briefingId)[0];
    expect(JSON.parse(brief.provenance).simulatedSources).toBe(false);
  });

  it("leaves no agent showing a current step once the briefing is done", async () => {
    const ctx = seededCtx();
    await dailyBriefing(ctx, null, stubLlm("digest"));
    expect(all(ctx.db, "SELECT id FROM agents WHERE current_step IS NOT NULL OR status = 'running'")).toEqual([]);
    // …but a step in progress is recorded (the sidebar shows it).
    expect(all<{ last_run_at: string | null }>(ctx.db, "SELECT last_run_at FROM agents WHERE id = 'knowledge'")[0].last_run_at).not.toBeNull();
  });

  it("records a failing source without breaking the others", async () => {
    const ctx = seededCtx();
    for (const s of listSources(ctx).slice(0, 2)) setSourceEnabled(ctx, s.id, true);
    let n = 0;
    const report = await refreshFeeds(ctx, async () => (n++ === 0 ? Promise.reject(new FeedError("Feed returned HTTP 500")) : RSS));
    expect(report.map((r) => r.ok)).toEqual([false, true]);
  });

  it("news refresh is denied when the Knowledge agent loses access", async () => {
    const ctx = seededCtx();
    ctx.db.prepare("UPDATE agent_permissions SET access_level = 'none' WHERE agent_id = 'knowledge' AND service_id = 'public-news'").run();
    await expect(callTool(ctx, "knowledge", "news.refresh", {}, new RunBudget(3, 5000))).rejects.toThrow(/requires/);
  });
});
