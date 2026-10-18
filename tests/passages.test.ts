import { describe, expect, it } from "vitest";
import { contentWords, relevantPassages } from "@/server/agents/passages";
import { webPrompt } from "@/server/agents/assistant";

const PAGE = [
  "Skip to content. Menu. Home About Contact. Accept all cookies to continue.",
  "Lisbon is the capital and largest city of Portugal.",
  "The city is known for its trams, its seven hills and the Belém tower.",
  "Lisbon has an estimated population of 567,131 people within its administrative limits, while the metropolitan area has about 2.9 million.",
  "The climate is Mediterranean with mild winters.",
  "Football clubs include Benfica and Sporting.",
].join(" ") + " " + "Unrelated filler text about tourism and food. ".repeat(80);

describe("relevantPassages: the parts of a page that answer the question", () => {
  it("keeps the sentence with the answer and drops the menus and filler", () => {
    const out = relevantPassages(PAGE, "how many people live in lisbon population");
    expect(out).toMatch(/567,131/);
    expect(out).not.toMatch(/cookies/);
    expect(out.length).toBeLessThan(1000);
  });

  it("rare words count more: 'population' beats 'lisbon' on a page about Lisbon", () => {
    const out = relevantPassages(PAGE, "lisbon population", 200);
    expect(out).toMatch(/567,131/);
  });

  it("gives passages in page order, joined with an ellipsis", () => {
    const out = relevantPassages(PAGE, "lisbon capital population trams");
    const a = out.indexOf("capital"), b = out.indexOf("567,131");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(out).toMatch(/ … /);
  });

  it("a page with no word of the question gives only its opening; empty input stays empty", () => {
    expect(relevantPassages(PAGE, "volcano eruption").length).toBeLessThanOrEqual(300);
    expect(relevantPassages("", "anything")).toBe("");
    expect(relevantPassages("Some text.", "")).toBe("Some text.");
  });

  it("is fast on a 12,000-character page and never throws on odd text", () => {
    const big = "word ".repeat(2400);
    const t = performance.now();
    relevantPassages(big, "word count");
    relevantPassages("😀 ((( [[[ $1 .* ".repeat(500), "regex (.*) [1]");
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("light stemming: 'lives' meets 'live', accents fold", () => {
    expect(contentWords("Who lives in Belém?")).toEqual(["live", "belem"]);
  });
});

describe("webPrompt: what the model reads for a web answer", () => {
  const found = {
    results: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, title: `Result ${i + 1}`, url: `https://example${i + 1}.org/page`, snippet: `Snippet ${i + 1}` })),
    pages: new Map([[1, PAGE]]),
  };
  it("passages (default): 6 snippets and the relevant part of each page read", () => {
    const p = webPrompt("how many people live in lisbon", "lisbon population", "2026-10-17", found);
    expect(p).toMatch(/Snippet 6/);
    expect(p).not.toMatch(/Snippet 7/);
    expect(p).toMatch(/567,131/);
    expect(p).not.toMatch(/cookies/);
    expect(p.length).toBeLessThan(2500);
  });
  it("lead (the former prompt): every snippet and the first 2,500 characters of each page", () => {
    const p = webPrompt("how many people live in lisbon", "lisbon population", "2026-10-17", found, "lead");
    expect(p).toMatch(/Snippet 8/);
    expect(p).toMatch(/cookies/);
  });
});

import { cleanText } from "@/server/news/feeds";
import { pageText } from "@/server/connectors/websearch";

describe("page text: attributes never leak into the text", () => {
  it("a '>' inside a quoted attribute (Wikipedia's data-mw JSON) doesn't end the tag", () => {
    const html = `<p><span typeof="mw:Transclusion" data-mw='{"parts":[{"wt":"<ref name=\\"x\\"/>"}]}'>Everest is 8,848 m high.</span><!-- a > comment --></p>`;
    expect(cleanText(html, 500)).toBe("Everest is 8,848 m high.");
    expect(pageText(`<main>${html}</main>`, 500)).toBe("Everest is 8,848 m high.");
  });
  it("plain text with < and > stays readable, and a long hostile string is fast", () => {
    expect(cleanText("2 < 3 and 5 > 4", 100)).toBe("2 < 3 and 5 > 4");
    const t = performance.now();
    cleanText(`<a title="${"x".repeat(50_000)}`, 100);
    cleanText("<a " + "'".repeat(20_000) + ">", 100);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
