"use client";

import { useState } from "react";
import type { SectionProps } from "../Dashboard";
import type { RetrievalResult, RetrievalProviderId, TraceStep } from "@/server/retrieval/knowledge";
import { EVAL_QUERIES } from "@/server/seed/evalQueries";
import { Badge, Button, Card, cx, Empty, inputCls, SectionHeader, Spinner, useToast, type Tone } from "../ui";
import { post } from "../api";
import { ServiceIcon } from "../icons";

const PROVIDERS: { id: RetrievalProviderId; name: string; where: string; tone: Tone }[] = [
  { id: "lexical", name: "Keyword (BM25)", where: "Local · zero setup", tone: "local" },
  { id: "local-semantic", name: "voyage-4-nano", where: "Local · open weights, CPU", tone: "voyage" },
  { id: "local-hybrid", name: "Hybrid (keyword + nano)", where: "Local · rank fusion", tone: "voyage" },
  { id: "atlas-nano", name: "Atlas Vector Search, local query", where: "Cloud search · no Voyage call", tone: "mongo" },
  { id: "atlas-hybrid", name: "Atlas hybrid ($rankFusion)", where: "Cloud · vector + full-text", tone: "mongo" },
  { id: "atlas-voyage", name: "Atlas Vector Search + Voyage AI", where: "Cloud · free tiers, opt-in", tone: "mongo" },
];

const SYSTEM_TONE: Record<TraceStep["system"], Tone> = { "Voyage AI": "voyage", "MongoDB Atlas": "mongo", Local: "local", Ollama: "local" };

export function ShowcaseView({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [query, setQuery] = useState(EVAL_QUERIES[0].query);
  const [primary, setPrimary] = useState<RetrievalProviderId>("lexical");
  const [compare, setCompare] = useState<RetrievalProviderId | "">("");
  const [sourceType, setSourceType] = useState("");
  const [results, setResults] = useState<RetrievalResult[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const available: Record<RetrievalProviderId, { ok: boolean; why?: string }> = {
    lexical: { ok: true },
    "local-semantic": state.knowledge.stats.nanoInstalled ? { ok: true } : { ok: false, why: "Run npm run setup:local-embeddings (one-time ~420 MB download)" },
    "local-hybrid": state.knowledge.stats.nanoInstalled ? { ok: true } : { ok: false, why: "Run npm run setup:local-embeddings (one-time ~420 MB download)" },
    "atlas-nano": !state.live.enabled ? { ok: false, why: state.live.reasons.join("; ") } : !state.knowledge.stats.nanoInstalled ? { ok: false, why: "Needs voyage-4-nano (npm run setup:local-embeddings)" } : { ok: true },
    "atlas-hybrid": !state.live.enabled ? { ok: false, why: state.live.reasons.join("; ") } : !state.knowledge.stats.nanoInstalled ? { ok: false, why: "Needs voyage-4-nano (npm run setup:local-embeddings)" } : { ok: true },
    "atlas-voyage": state.live.enabled ? { ok: true } : { ok: false, why: state.live.reasons.join("; ") },
  };
  const tags = [...new Set(state.knowledge.documents.flatMap((d) => d.tags))].sort();
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  // In the personal app, Atlas holds only the notes you shared yourself: say so when there are none.
  const sharedNotes = state.knowledge.documents.filter((d) => !d.is_demo && d.atlas_share).length;
  const atlasEmptyHint =
    state.config.mode === "personal" && sharedNotes === 0
      ? "In your personal app, Atlas searches only the notes you share (Knowledge & Data → Share to Atlas), and none are shared yet. The fictional demo notes live in the demo app."
      : undefined;

  async function search() {
    setSearching(true);
    setErrors({});
    const providers = [primary, ...(compare && compare !== primary ? [compare] : [])];
    const out: RetrievalResult[] = [];
    const errs: Record<string, string> = {};
    for (const provider of providers) {
      try {
        out.push(await post<RetrievalResult>("/api/knowledge", { op: "search", input: { query, provider, k: 4, filters: { sourceType: sourceType || undefined, tags: tagFilter.length ? tagFilter : undefined } } }));
      } catch (e) {
        errs[provider] = (e as Error).message;
      }
    }
    setResults(out);
    setErrors(errs);
    setSearching(false);
  }

  const [streaming, setStreaming] = useState<Record<string, string>>({});

  /** Reads the NDJSON answer stream and shows tokens as the local model writes them. */
  async function answer(id: string) {
    setBusy(`answer-${id}`);
    setStreaming((s) => ({ ...s, [id]: "" }));
    try {
      const res = await fetch("/api/knowledge/answer", {
        method: "POST",
        headers: { "content-type": "application/json", "x-acc-request": "1" },
        body: JSON.stringify({ retrievalId: id }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { t?: string; done?: boolean; result?: RetrievalResult; error?: string };
          if (msg.error) throw new Error(msg.error);
          if (msg.t) setStreaming((s) => ({ ...s, [id]: (s[id] ?? "") + msg.t }));
          if (msg.done && msg.result) setResults((rs) => rs.map((r) => (r.id === id ? msg.result! : r)));
        }
      }
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setStreaming((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
      setBusy(null);
    }
  }

  async function op(body: Record<string, unknown>, key: string, ok: (r: unknown) => string, path = "/api/knowledge") {
    setBusy(key);
    try {
      const r = await post(path, body);
      toast(ok(r), "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Under the hood: how search works"
        description="Ask a question in your own words and compare which passages each search method finds, and which steps ran where. Each run is labelled with what actually handled it."
        actions={
          state.config.mode !== "personal" && <Button variant="danger" busy={busy === "reset"} onClick={() => confirm("Reset all demo data? Your own documents are kept.") && op({ op: "reset" }, "reset", () => "Demo data reset", "/api/showcase")}>
            Reset demo
          </Button>
        }
      />

      <Card>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Retrieval provider">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={primary === p.id}
              aria-label={`${p.name} — ${p.where}${available[p.id].ok ? "" : " (unavailable)"}`}
              disabled={!available[p.id].ok}
              title={available[p.id].why}
              onClick={() => setPrimary(p.id)}
              className={cx("rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50", primary === p.id ? "border-accent bg-accent-soft" : "border-line hover:bg-panel-2")}
            >
              <Badge tone={p.tone}>{p.where}</Badge>
              <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold">
                {(p.id === "atlas-nano" || p.id === "atlas-hybrid") && <ServiceIcon id="atlas" size={16} />}
                {p.id === "atlas-voyage" && (
                  <>
                    <ServiceIcon id="atlas" size={16} />
                    <ServiceIcon id="voyage" size={16} />
                  </>
                )}
                {(p.id === "local-semantic" || p.id === "local-hybrid") && <ServiceIcon id="voyage" size={16} />}
                {p.name}
              </p>
              {!available[p.id].ok && <p className="mt-1 text-[11px] text-muted">Unavailable: {available[p.id].why}</p>}
            </button>
          ))}
        </div>

        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <label htmlFor="q" className="sr-only">
            Question
          </label>
          <input id="q" className={cx(inputCls, "flex-1 text-base")} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} placeholder="Ask your notes anything…" />
          <Button type="submit" variant="primary" size="md" busy={searching} disabled={query.trim().length < 2}>
            Search
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EVAL_QUERIES.slice(0, 6).map((q) => (
            <button key={q.query} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-ink" onClick={() => setQuery(q.query)}>
              {q.query}
            </button>
          ))}
          <button className="rounded-full border border-danger px-2 py-0.5 text-[11px] text-danger hover:bg-danger-soft" onClick={() => setQuery("What did the recipes newsletter say?")} title="Retrieves the planted prompt-injection document">
            Try the poisoned newsletter
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="text-muted">Compare with</span>
            <select className="rounded-md border border-line bg-panel px-1.5 py-1" value={compare} onChange={(e) => setCompare(e.target.value as RetrievalProviderId | "")}>
              <option value="">— nothing —</option>
              {PROVIDERS.filter((p) => p.id !== primary).map((p) => (
                <option key={p.id} value={p.id} disabled={!available[p.id].ok}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-muted">Type filter</span>
            <select className="rounded-md border border-line bg-panel px-1.5 py-1" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              <option value="">any</option>
              {["note", "journal", "guide", "newsletter", "csv_row"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted">Tags</span>
            {tags.map((t) => (
              <button
                key={t}
                aria-pressed={tagFilter.includes(t)}
                onClick={() => setTagFilter((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]))}
                className={cx("rounded-full border px-2 py-0.5", tagFilter.includes(t) ? "border-accent bg-accent-soft text-accent" : "border-line text-muted")}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {Object.entries(errors).map(([p, msg]) => (
        <p key={p} className="mt-3 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {PROVIDERS.find((x) => x.id === p)?.name}: {msg}
        </p>
      ))}

      {searching && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <Spinner /> Searching…
        </p>
      )}

      {results.length > 0 && (
        <div className={cx("mt-4 grid gap-4", results.length > 1 && "lg:grid-cols-2")}>
          {results.map((r) => (
            <ResultPanel key={r.id} result={r} onAnswer={() => answer(r.id)} answering={busy === `answer-${r.id}`} partial={streaming[r.id]} model={state.llm.interactive} emptyHint={r.runLabel !== "Local" ? atlasEmptyHint : undefined} />
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Set up the providers" subtitle="Each one is explicit and opt-in. Nothing downloads, indexes or leaves this machine on its own.">
          <ol className="space-y-4 text-sm">
            <li>
              <p className="font-medium">1 · Local semantic search (voyage-4-nano)</p>
              <p className="text-xs text-muted">
                {state.knowledge.stats.nanoInstalled ? "Model installed." : "Model not installed — run npm run setup:local-embeddings once (~420 MB, Apache-2.0)."} {state.knowledge.stats.localVectors}/{state.knowledge.stats.chunks} chunks indexed locally.
              </p>
              <Button className="mt-1.5" disabled={!state.knowledge.stats.nanoInstalled} busy={busy === "index"} onClick={() => op({ op: "index-local" }, "index", (r) => `Indexed ${(r as { embedded: number }).embedded} new chunks locally`)}>
                Index locally
              </Button>
            </li>
            <li>
              <p className="font-medium">2 · Atlas + Voyage live mode</p>
              {state.live.configured ? (
                <p className="text-xs text-muted">Configured in .env.local (Atlas database “{state.config.atlas.dbName}”, {state.config.voyage.embedModel} @ {state.config.voyage.dimensions} dims, rerank {state.config.voyage.rerankModel}).</p>
              ) : (
                <p className="text-xs text-muted">Not configured. Set ATLAS_ENABLED, MONGODB_URI, VOYAGE_ENABLED and VOYAGE_API_KEY in .env.local, then run npm run atlas:setup. See the README.</p>
              )}
              <label className="mt-2 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={state.live.consent}
                  disabled={!state.live.configured || busy === "consent"}
                  onChange={(e) => op({ op: "consent", value: e.target.checked }, "consent", () => (e.target.checked ? "Live mode enabled" : "Live mode disabled"), "/api/showcase")}
                />
                <span>
                  I confirm my Atlas cluster is the free M0 tier and my Voyage AI usage stays within its free token allowance.{" "}
                  {state.config.mode === "demo"
                    ? "Only the fictional demo corpus is sent to these services."
                    : state.config.mode === "personal"
                      ? "Only the notes I share one by one (Knowledge & Data) are sent to these services, never email."
                      : "Only the fictional demo corpus and the notes I share one by one (Knowledge & Data) are sent to these services, never email."}
                </span>
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button disabled={!state.live.configured} busy={busy === "status"} onClick={() => op({ op: "atlas-status" }, "status", (r) => describeAtlas(r as AtlasStatus))}>
                  Check Atlas status
                </Button>
                <Button disabled={!state.live.enabled} busy={busy === "sync"} onClick={() => op({ op: "sync-atlas" }, "sync", (r) => describeSync(r as SyncResult))}>
                  {state.config.mode === "personal" ? "Sync shared notes to Atlas" : state.config.mode === "demo" ? "Sync demo corpus to Atlas" : "Sync to Atlas"}
                </Button>
              </div>
            </li>
          </ol>
        </Card>

        <Card title="Search quality" subtitle={state.evaluation ? `${state.evaluation.queries} paraphrased questions · run ${new Date(state.evaluation.ranAt).toLocaleString()}` : "Run npm run eval to measure"}>
          {state.evaluation && <RecallChart evaluation={state.evaluation} />}
          {state.evaluation ? (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 font-medium">Provider</th>
                  <th className="font-medium">Recall@1</th>
                  <th className="font-medium">Recall@3</th>
                  <th className="font-medium">MRR</th>
                  <th className="font-medium">Avg time</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(state.evaluation.results).map(([p, r]) => (
                  <tr key={p} className="border-t border-line">
                    <td className="py-1.5">
                      {PROVIDERS.find((x) => x.id === p)?.name ?? p}
                      {r.queries && r.queries !== state.evaluation!.queries && <span className="block text-[10px] text-muted">earlier run, {r.queries} questions</span>}
                    </td>
                    <td>{pct(r.recallAt1)}</td>
                    <td>{pct(r.recallAt3)}</td>
                    <td>{r.mrr.toFixed(2)}</td>
                    <td>{r.avgMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {state.evaluation?.questions && <EvalBreakdown evaluation={state.evaluation} />}
          {!state.evaluation && (
            <Empty title="No evaluation yet">Run npm run eval in a terminal. It only measures providers that are actually available.</Empty>
          )}
          <p className="mt-3 text-[11px] text-muted">A tiny fictional corpus: useful to illustrate differences, not a benchmark. Latency includes network round-trips for cloud providers.</p>
        </Card>
      </div>

      <Card className="mt-4" title="Architecture" subtitle="What runs where, and where the permission checkpoints sit." actions={<a className="text-xs text-accent underline" href="/architecture.svg" target="_blank" rel="noopener">Open full size</a>}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG diagram, no optimisation needed */}
        <img src="/architecture.svg" alt="Architecture: the browser and MCP client reach guarded API routes; the Chief of Staff delegates to four specialists whose typed tools pass a policy engine before touching SQLite; approvals are hash-bound; retrieval runs locally (BM25, voyage-4-nano, Ollama) or opt-in through MongoDB Atlas and the Voyage AI API; Google and RSS sources are read-only." className="w-full rounded-lg border border-line" />
      </Card>

      <Card className="mt-4" title="What each piece does">
        <div className="grid gap-4 text-sm md:grid-cols-3">
          <div>
            <Badge tone="voyage">Voyage AI</Badge>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted">
              <li>Turns passages and questions into embeddings (vectors that capture meaning).</li>
              <li>The voyage-4 models share one embedding space: voyage-4-nano runs locally (open weights) and its query vectors can search an index built with the hosted voyage-4-lite (“Atlas Vector Search, local query”).</li>
              <li>A reranker reorders the shortlist by reading query and passage together.</li>
            </ul>
          </div>
          <div>
            <Badge tone="mongo">MongoDB Atlas</Badge>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted">
              <li>Stores each chunk as one document: text, source reference, metadata and its vector, together.</li>
              <li>$vectorSearch finds nearest neighbours, with metadata pre-filters (type, tags) applied in the same query.</li>
              <li>Uses the free M0 tier in this project; opt-in only.</li>
            </ul>
          </div>
          <div>
            <Badge tone="local">This machine</Badge>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted">
              <li>SQLite holds the app data; BM25 is the keyword baseline; voyage-4-nano gives offline semantic search.</li>
              <li>The local LLM ({state.llm.interactive} for answers, {state.llm.background} for briefings and drafts) writes text only from retrieved data — it has no tools.</li>
              <li>Permissions and approvals are enforced here, server-side.</li>
            </ul>
          </div>
        </div>
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer font-medium">When semantic search helps, and sharing screenshots safely</summary>
          <div className="mt-2 grid gap-4 md:grid-cols-2">
            <div className="space-y-1 text-muted">
              <p>Personal knowledge is scattered and phrased inconsistently: a note says “drivetrain tune-up”, you ask “when is my bike repaired?”. Semantic retrieval finds it anyway, and metadata filters keep it scoped. Grounded answers with citations let you check the source instead of trusting the model.</p>
              <p>This doesn&apos;t mean every workload needs a vector database: for a few hundred local notes an in-process scan is fine (that&apos;s what local mode does). A hosted index only becomes worth it when the corpus or the number of users grows.</p>
            </div>
            <ul className="list-inside list-disc space-y-1 text-muted">
              <li>Only capture this demo data; it is fictional and uses example.com addresses.</li>
              <li>Never show .env.local, terminals with connection strings, or the Atlas UI&apos;s connection dialog.</li>
              <li>Show the run label (“Atlas + Voyage live” vs “Local”) and the trace, so viewers see what actually ran.</li>
                            <li>Use Reset demo to start from a clean state.</li>
            </ul>
          </div>
        </details>
      </Card>
    </div>
  );
}

type AtlasStatus = { reachable: boolean; chunkCount?: number; indexStatus?: string; indexQueryable?: boolean; searchIndexCount?: number; error?: string };
function describeAtlas(s: AtlasStatus) {
  if (!s.reachable) return `Atlas not reachable: ${s.error}`;
  return `Atlas reachable · ${s.chunkCount} chunks · vector index ${s.indexStatus ?? "missing (run npm run atlas:setup)"}${s.indexQueryable ? " (queryable)" : ""}`;
}

type SyncResult = { demoChunks: number; noteChunks: number; removed: number };
function describeSync(r: SyncResult) {
  const parts = [r.demoChunks ? `${r.demoChunks} demo chunks` : null, r.noteChunks ? `${r.noteChunks} chunks of your shared notes` : null].filter(Boolean);
  const head = parts.length ? `Embedded ${parts.join(" and ")} with Voyage AI and stored them in Atlas` : "Nothing to sync: no notes are shared";
  return r.removed ? `${head}; removed ${r.removed} no longer shared` : head;
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

/**
 * Recall@1 per provider as horizontal bars: one series, so no legend. Keyword search is the baseline
 * and wears the muted colour; every other bar uses the accent. The table below is the full view.
 */
function RecallChart({ evaluation }: { evaluation: NonNullable<SectionProps["state"]["evaluation"]> }) {
  const rows = PROVIDERS.filter((p) => evaluation.results[p.id]).map((p) => ({ ...p, r: evaluation.results[p.id] }));
  if (rows.length < 2) return null;
  return (
    <figure className="mb-4" aria-label="Right note first (recall@1) per search provider">
      <figcaption className="mb-2 text-xs font-medium text-muted">Right note ranked first (recall@1)</figcaption>
      <ul className="space-y-1.5">
        {rows.map(({ id, name, r }) => (
          <li
            key={id}
            className="group grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-2 text-xs sm:grid-cols-[minmax(0,15rem)_1fr]"
            title={`${name}: recall@1 ${pct(r.recallAt1)}, recall@3 ${pct(r.recallAt3)}, ${r.avgMs} ms average`}
          >
            <span className="truncate text-ink">{name}</span>
            <span className="flex items-center gap-2">
              <span className="relative h-3.5 flex-1 rounded-r-[4px] bg-panel-2">
                <span
                  className={cx("absolute inset-y-0 left-0 rounded-r-[4px] transition-opacity group-hover:opacity-80", id === "lexical" ? "bg-muted" : "bg-accent")}
                  style={{ width: `${Math.max(r.recallAt1 * 100, 1)}%` }}
                />
              </span>
              <span className="w-9 text-right font-semibold tabular-nums text-ink">{pct(r.recallAt1)}</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function ResultPanel({ result, onAnswer, answering, partial, model, emptyHint }: { result: RetrievalResult; onAnswer: () => void; answering: boolean; partial?: string; model: string; emptyHint?: string }) {
  const live = result.runLabel !== "Local";
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={live ? "mongo" : "local"}>{result.runLabel}</Badge>
        <span className="text-sm font-semibold">{result.providerLabel}</span>
      </div>
      <ol className="mt-3 space-y-1.5" aria-label="Pipeline trace">
        {result.trace.map((t, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-4 text-right text-muted">{i + 1}</span>
            <Badge tone={SYSTEM_TONE[t.system]}>
              {t.system === "MongoDB Atlas" && <ServiceIcon id="atlas" size={12} />}
              {t.system === "Voyage AI" && <ServiceIcon id="voyage" size={12} />}
              {t.system === "Local" ? "Local" : `${t.system} · ${t.location}`}
            </Badge>
            <span>{t.operation}</span>
            <span className="text-muted">{t.ms} ms</span>
            <span className="w-full pl-6 font-mono text-[10px] text-muted">
              {Object.entries(t.detail)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ")}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-4 space-y-2">
        {result.passages.length === 0 ? (
          <Empty title="No passages matched">{emptyHint}</Empty>
        ) : (
          result.passages.map((p) => (
            <article key={p.chunkId} className={cx("rounded-lg border p-3", p.flags.length ? "border-danger" : "border-line")}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-muted">[{p.rank}]</span>
                <span className="font-semibold">{p.title}</span>
                <Badge>{p.sourceType}</Badge>
                <span className="ml-auto font-mono text-muted" title={p.scoreKind}>
                  {p.scoreKind.split(" ")[0]} {p.score}
                </span>
              </div>
              {p.flags.length > 0 && (
                <p className="mt-1.5 rounded bg-danger-soft px-2 py-1 text-[11px] text-danger">
                  ⚠ Contains instruction-like text ({p.flags.join(", ")}). Treated as data only: it cannot trigger tools, approvals or permission changes.
                </p>
              )}
              <WhyMatched query={result.query} title={p.title} text={p.text} semantic={result.provider !== "lexical"} />
              <p className="mt-1 text-[11px] text-muted">
                Source: <code>{p.sourceRef}</code> {p.tags.length > 0 && `· ${p.tags.join(", ")}`}
              </p>
            </article>
          ))
        )}
      </div>

      <div className="mt-4 rounded-lg bg-panel-2 p-3">
        {result.answer ? (
          <>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold">Grounded answer</span>
              <Badge tone="local">{result.answer.method === "llm" ? `${result.answer.model} · local` : "extractive (no LLM)"}</Badge>
            </div>
            <p className="whitespace-pre-line text-sm">{result.answer.text}</p>
            {result.answer.note && <p className="mt-1 text-[11px] text-muted">{result.answer.note}</p>}
          </>
        ) : partial !== undefined ? (
          <div aria-live="polite">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold">Grounded answer</span>
              <Badge tone="local">
                <Spinner /> {model} · writing locally
              </Badge>
            </div>
            <p className="whitespace-pre-line text-sm">{partial || <span className="text-muted">Reading the passages… (on a laptop CPU the first words can take 30–60 s)</span>}</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">Generate an answer from these passages with the local LLM ({model}). Words appear as they are written.</p>
            <Button busy={answering} onClick={onAnswer} disabled={result.passages.length === 0}>
              {answering ? "Generating locally…" : "Generate grounded answer"}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function EvalBreakdown({ evaluation }: { evaluation: NonNullable<SectionProps["state"]["evaluation"]> }) {
  const providers = Object.entries(evaluation.results).filter(([, r]) => r.ranks && r.ranks.length === evaluation.questions!.length);
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-medium">Per-question ranks (where the right note landed; – = not in the top 5)</summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-panel text-muted">
            <tr>
              <th className="py-1 font-medium">Question</th>
              {providers.map(([p]) => (
                <th key={p} className="px-1 font-medium">
                  {PROVIDERS.find((x) => x.id === p)?.name.split(" ")[0] ?? p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evaluation.questions!.map((q, i) => (
              <tr key={q} className="border-t border-line">
                <td className="py-1 pr-2">{q}</td>
                {providers.map(([p, r]) => {
                  const rank = r.ranks![i];
                  return (
                    <td key={p} className={cx("px-1 text-center font-mono", rank === 1 ? "text-ok" : rank ? "text-warn" : "text-danger")}>
                      {rank ?? "–"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const STOPWORDS = new Set("the and for are was were what when where which who why how does did do can could should would will with from into about this that these those there their them they you your yours have has had not but out over under than then too very just also its it's i'm my me our we is am be been being of to in on at by an a as or if so no yes any all".split(" "));

function queryTerms(query: string) {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Highlights query words in the passage and says whether it matched on words or on meaning. */
function WhyMatched({ query, title, text, semantic }: { query: string; title: string; text: string; semantic: boolean }) {
  const terms = queryTerms(query);
  // Loose stemming: "repaired" matches "repair", "bicycles" matches "bicycle".
  const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, "");
  const stems = new Set(terms.map(stem));
  const isHit = (w: string) => stems.has(stem(w));
  const shared = terms.filter((t) => (`${title} ${text}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).some((w) => stem(w) === stem(t)));
  const parts = text.split(/([\p{L}\p{N}]+)/u);
  return (
    <>
      <p className="mt-1.5 whitespace-pre-line text-sm">
        {parts.map((part, i) =>
          i % 2 === 1 && isHit(part) ? (
            <mark key={i} className="rounded bg-warn-soft px-0.5 text-ink">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </p>
      <p className="mt-1 text-[11px] text-muted">
        {shared.length ? (
          <>Shared words: {shared.join(", ")}</>
        ) : semantic ? (
          <span className="font-medium text-voyage">Matched by meaning — no words in common with your question</span>
        ) : (
          "No shared words"
        )}
      </p>
    </>
  );
}
