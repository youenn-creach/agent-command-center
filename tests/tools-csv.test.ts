import { describe, expect, it } from "vitest";
import { callTool, ToolInputError } from "@/server/tools/registry";
import { BudgetExceededError, RunBudget } from "@/server/tools/budget";
import { PolicyError } from "@/server/policy/engine";
import { setServiceLevel } from "@/server/policy/permissions";
import { CsvError, importCsv, parseCsv, previewCsv } from "@/server/csv";
import { loadConfig } from "@/server/config";
import { all } from "@/server/db";
import { seededCtx } from "./helpers";

describe("tool calls are authorized server-side", () => {
  it("denies a read the agent was never granted", async () => {
    const ctx = seededCtx();
    await expect(callTool(ctx, "inbox", "calendar.list_events", { from: "2026-10-12T00:00:00Z", days: 1 }, new RunBudget(5, 5000))).rejects.toThrow(PolicyError);
  });

  it("the orchestrator has no direct data access", async () => {
    const ctx = seededCtx();
    await expect(callTool(ctx, "chief_of_staff", "inbox.list_messages", { limit: 5 }, new RunBudget(5, 5000))).rejects.toThrow(PolicyError);
  });

  it("denies after the service level is lowered", async () => {
    const ctx = seededCtx();
    const budget = new RunBudget(5, 5000);
    await callTool(ctx, "knowledge", "news.list_items", { limit: 3 }, budget);
    setServiceLevel(ctx, "public-news", "none");
    await expect(callTool(ctx, "knowledge", "news.list_items", { limit: 3 }, budget)).rejects.toThrow(PolicyError);
  });

  it("cannot propose on a service the tool does not allow", async () => {
    const ctx = seededCtx();
    await expect(
      callTool(ctx, "follow_up", "actions.propose", { serviceId: "gmail", kind: "reminder", title: "x", payload: { text: "x" }, idempotencyKey: "k" }, new RunBudget(5, 5000)),
    ).rejects.toThrow(ToolInputError);
  });

  it("validates tool inputs", async () => {
    const ctx = seededCtx();
    await expect(callTool(ctx, "knowledge", "news.list_items", { limit: 999 }, new RunBudget(5, 5000))).rejects.toThrow(ToolInputError);
  });

  it("enforces the per-run tool-call budget", async () => {
    const ctx = seededCtx();
    const budget = new RunBudget(2, 5000);
    await callTool(ctx, "knowledge", "news.list_items", { limit: 1 }, budget);
    await callTool(ctx, "knowledge", "news.list_items", { limit: 1 }, budget);
    await expect(callTool(ctx, "knowledge", "news.list_items", { limit: 1 }, budget)).rejects.toThrow(BudgetExceededError);
  });

  it("enforces the run deadline", () => {
    let t = 0;
    const budget = new RunBudget(10, 100, () => t);
    t = 101;
    expect(() => budget.spend("x")).toThrow(/timed out/);
  });
});

describe("CSV import", () => {
  it("parses quoted fields, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("previews valid rows and reports bad ones with line numbers", () => {
    const p = previewCsv("title,content,tags\nGood,Some text,home;ideas\n,missing title,\nShort,row\n");
    expect(p.valid).toHaveLength(1);
    expect(p.valid[0].tags).toEqual(["home", "ideas"]);
    expect(p.errors.map((e) => e.line)).toEqual([3, 4]);
  });

  it("rejects missing headers, oversize files and unterminated quotes", () => {
    expect(() => previewCsv("name,body\nx,y\n")).toThrow(CsvError);
    expect(() => previewCsv("title,content\n" + "x,".padEnd(250_000, "y"))).toThrow(/larger than/);
    expect(() => previewCsv('title,content\n"x,y\n')).toThrow(/Unterminated/);
  });

  it("warns about spreadsheet formula characters", () => {
    const p = previewCsv("title,content\n=HYPERLINK(1),text\n");
    expect(p.valid[0].warnings[0]).toMatch(/formula/);
  });

  it("imports only valid rows, as non-demo documents, without indexing them", () => {
    const ctx = seededCtx();
    const r = importCsv(ctx, "title,content\nIdea,Write the blog post\n,bad\n", "../../etc/passwd.csv");
    expect(r).toEqual({ imported: 1, rejected: 1 });
    const docs = all<{ source_ref: string; is_demo: number }>(ctx.db, "SELECT source_ref, is_demo FROM documents WHERE source_type = 'csv_row'");
    expect(docs[0].is_demo).toBe(0);
    expect(docs[0].source_ref).not.toContain("/");
    expect(all(ctx.db, "SELECT * FROM embeddings")).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("refuses a non-local Ollama URL so data cannot silently go to a hosted LLM", () => {
    expect(() => loadConfig({ OLLAMA_URL: "https://llm.example.com" })).toThrow(/OLLAMA_URL/);
  });

  it("requires credentials when a hosted provider is enabled, without echoing values", () => {
    expect(() => loadConfig({ VOYAGE_ENABLED: "true" })).toThrow(/VOYAGE_API_KEY/);
    try {
      loadConfig({ ATLAS_ENABLED: "true", MONGODB_URI: "http://user:secret@host" });
    } catch (e) {
      expect(String(e)).not.toContain("secret");
    }
  });

  it("treats empty variables as unset", () => {
    expect(loadConfig({ GOOGLE_CLIENT_ID: "", VOYAGE_ENABLED: "" }).GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it("defaults hosted providers to off", () => {
    const c = loadConfig({});
    expect(c.ATLAS_ENABLED).toBe(false);
    expect(c.VOYAGE_ENABLED).toBe(false);
  });
});
