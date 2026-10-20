import { z } from "zod";
import { appMode, demoRowsFilter } from "../mode";
import { randomBytes } from "node:crypto";
import { all, getSetting, newId, one, run, setSetting, tx, type Ctx } from "../db";
import { config } from "../config";
import { UserError } from "../errors";
import { logActivity } from "../activity";
import { fenceUntrusted, workLlm, UNTRUSTED_DATA_RULES, type LlmProvider } from "../llm";
import { bm25, chunkText, injectionFlags } from "./text";
import { dot, fromBlob, nanoModelInstalled, nanoProvider, reserveVoyageRequests, toBlob, voyageApiProvider, voyageRerank, VoyageRateLimitError, type EmbeddingProvider } from "./embeddings";
import { atlasHybridSearch, atlasVectorSearch, deleteSharedChunks, deleteStaleSharedChunks, ensureTextIndex, ensureVectorIndex, safeError, upsertChunks, type AtlasChunk, type AtlasScope } from "./atlas";

export const RETRIEVAL_PROVIDERS = ["lexical", "local-semantic", "local-hybrid", "atlas-nano", "atlas-hybrid", "atlas-voyage"] as const;
export type RetrievalProviderId = (typeof RETRIEVAL_PROVIDERS)[number];

export const RetrieveInputSchema = z.object({
  query: z.string().trim().min(2).max(500),
  provider: z.enum(RETRIEVAL_PROVIDERS),
  filters: z
    .object({
      sourceType: z.string().max(40).optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
    })
    .default({}),
  k: z.number().int().min(1).max(8).default(4),
  answer: z.boolean().default(false),
  /** The user's own question for the answer, when `query` is search words ("kitchen quote B time" for "how long does quote B take"). */
  question: z.string().trim().min(2).max(500).optional(),
});
export type RetrieveInput = z.input<typeof RetrieveInputSchema>;

export interface Passage {
  rank: number;
  chunkId: string;
  docId: string;
  title: string;
  sourceType: string;
  sourceRef: string;
  tags: string[];
  text: string;
  score: number;
  scoreKind: string;
  flags: string[];
}

export interface TraceStep {
  system: "Voyage AI" | "MongoDB Atlas" | "Local" | "Ollama" | "Mistral API";
  location: "cloud" | "local";
  operation: string;
  detail: Record<string, string | number | boolean>;
  ms: number;
}

export interface RetrievalResult {
  id: string;
  createdAt: string;
  query: string;
  provider: RetrievalProviderId;
  runLabel: "Atlas + Voyage live" | "Atlas live · local query embedding" | "Atlas hybrid live · local query embedding" | "Local";
  providerLabel: string;
  filters: { sourceType?: string; tags?: string[] };
  passages: Passage[];
  trace: TraceStep[];
  answer?: { text: string; method: "llm" | "extractive"; model?: string; note?: string };
  error?: string;
}

interface ChunkJoin {
  id: string;
  doc_id: string;
  text: string;
  title: string;
  source_type: string;
  source_ref: string;
  tags: string;
  is_demo: number;
}

export const DocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceType: z.enum(["note", "article", "csv_row", "guide", "newsletter", "journal"]),
  sourceRef: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  content: z.string().min(1).max(50_000),
  isDemo: z.boolean().default(false),
});

export function addDocument(ctx: Ctx, input: z.input<typeof DocumentInputSchema>, fixedId?: string) {
  const doc = DocumentInputSchema.parse(input);
  const id = fixedId ?? newId("doc");
  tx(ctx.db, () => {
    run(
      ctx.db,
      "INSERT INTO documents (id, title, source_type, source_ref, tags, content, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      doc.title,
      doc.sourceType,
      doc.sourceRef,
      JSON.stringify(doc.tags),
      doc.content,
      doc.isDemo ? 1 : 0,
      ctx.now().toISOString(),
    );
    chunkText(doc.content).forEach((text, ord) => {
      run(ctx.db, "INSERT INTO chunks (id, doc_id, ord, text) VALUES (?, ?, ?, ?)", `${id}_${ord}`, id, ord, text);
    });
  });
  return id;
}

export function listDocuments(ctx: Ctx) {
  return all<{ id: string; title: string; source_type: string; source_ref: string; tags: string; is_demo: number; created_at: string; chunks: number; indexed: number; atlas_share: number; atlas_synced_at: string | null }>(
    ctx.db,
    `SELECT d.id, d.title, d.source_type, d.source_ref, d.tags, d.is_demo, d.created_at, d.atlas_share, d.atlas_synced_at,
       (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks,
       (SELECT COUNT(*) FROM chunks c JOIN embeddings e ON e.chunk_id = c.id WHERE c.doc_id = d.id) AS indexed
     FROM documents d WHERE 1 = 1${demoRowsFilter("d")} ORDER BY d.is_demo DESC, d.title`,
  ).map((d) => ({ ...d, tags: JSON.parse(d.tags) as string[] }));
}

/** Deletes a document; a note that was shared to Atlas is removed there first (nothing changes if that fails). */
export async function deleteDocument(ctx: Ctx, id: string) {
  const doc = one<{ atlas_synced_at: string | null }>(ctx.db, "SELECT atlas_synced_at FROM documents WHERE id = ?", id);
  if (doc?.atlas_synced_at) await removeFromAtlas(ctx, [id]);
  run(ctx.db, "DELETE FROM documents WHERE id = ?", id);
}

function loadChunks(ctx: Ctx, filters: { sourceType?: string; tags?: string[] }): ChunkJoin[] {
  return all<ChunkJoin>(
    ctx.db,
    `SELECT c.id, c.doc_id, c.text, d.title, d.source_type, d.source_ref, d.tags, d.is_demo
     FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE 1 = 1${demoRowsFilter("d")}`,
  ).filter((c) => {
    if (filters.sourceType && c.source_type !== filters.sourceType) return false;
    if (filters.tags?.length) {
      const tags = JSON.parse(c.tags) as string[];
      if (!filters.tags.some((t) => tags.includes(t))) return false;
    }
    return true;
  });
}

function toPassage(c: ChunkJoin, score: number, scoreKind: string, rank: number): Passage {
  return {
    rank,
    chunkId: c.id,
    docId: c.doc_id,
    title: c.title,
    sourceType: c.source_type,
    sourceRef: c.source_ref,
    tags: JSON.parse(c.tags) as string[],
    text: c.text,
    score: Math.round(score * 1000) / 1000,
    scoreKind,
    flags: injectionFlags(c.text),
  };
}

/** Embeds chunks that have no vector yet in the provider's space. Explicit, user-triggered. */
export async function indexLocal(ctx: Ctx, provider: EmbeddingProvider = nanoProvider()) {
  const missing = all<{ id: string; text: string; title: string }>(
    ctx.db,
    `SELECT c.id, c.text, d.title FROM chunks c JOIN documents d ON d.id = c.doc_id
     WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.space = ?)`,
    provider.space,
  );
  if (!missing.length) return { embedded: 0, ms: 0 };
  const { vectors, ms } = await provider.embed(missing.map((m) => `${m.title}\n${m.text}`), "document");
  tx(ctx.db, () => {
    missing.forEach((m, i) => {
      run(ctx.db, "INSERT OR REPLACE INTO embeddings (chunk_id, space, vector) VALUES (?, ?, ?)", m.id, provider.space, toBlob(vectors[i]));
    });
  });
  logActivity(ctx, {
    actor: "user",
    kind: "retrieval",
    outcome: "ok",
    summary: `Indexed ${missing.length} chunks locally with ${provider.model}`,
    detail: { space: provider.space, ms },
  });
  return { embedded: missing.length, ms };
}

export function liveModeStatus(ctx: Ctx) {
  const c = config();
  const consent = getSetting(ctx.db, "showcase.live_consent") === "true";
  const reasons: string[] = [];
  if (!c.ATLAS_ENABLED) reasons.push("ATLAS_ENABLED is not set");
  if (!c.VOYAGE_ENABLED) reasons.push("VOYAGE_ENABLED is not set");
  if (!consent) reasons.push("Live mode has not been confirmed in Under the hood");
  return { enabled: reasons.length === 0, configured: c.ATLAS_ENABLED && c.VOYAGE_ENABLED, consent, reasons };
}

/**
 * This instance's id on the shared Atlas collection. Shared notes carry it, so searches and
 * clean-ups only ever touch this instance's own notes.
 */
export function atlasOrigin(ctx: Ctx): string {
  let origin = getSetting(ctx.db, "atlas.origin");
  if (!origin) {
    origin = randomBytes(12).toString("hex");
    setSetting(ctx.db, "atlas.origin", origin);
  }
  return origin;
}

/** What Atlas searches cover here: the demo corpus in the demo, your shared notes in the personal app, both in mixed mode. */
export function atlasScope(ctx: Ctx): AtlasScope {
  const mode = appMode();
  return { demo: mode !== "personal", origin: mode === "demo" ? undefined : atlasOrigin(ctx) };
}

/**
 * Pushes to Atlas what this instance may share, embedded with the Voyage API: the fictional demo
 * corpus (not in the personal app) and the notes you shared one by one (not in the demo). Notes you
 * stopped sharing are removed from Atlas in the same pass. Never email: only Knowledge documents.
 */
export async function syncCorpusToAtlas(ctx: Ctx, onlyDocIds?: string[]) {
  const live = liveModeStatus(ctx);
  if (!live.enabled) throw new UserError(`Live mode is off: ${live.reasons.join("; ")}`);
  const mode = appMode();
  const scope = atlasScope(ctx);
  const provider = voyageApiProvider();
  const where = [mode !== "personal" ? "d.is_demo = 1" : null, mode !== "demo" ? "(d.is_demo = 0 AND d.atlas_share = 1)" : null].filter(Boolean).join(" OR ");
  let rows = all<ChunkJoin>(
    ctx.db,
    `SELECT c.id, c.doc_id, c.text, d.title, d.source_type, d.source_ref, d.tags, d.is_demo
     FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE ${where}`,
  );
  const sharedChunkIds = rows.filter((r) => !r.is_demo).map((r) => r.id);
  if (onlyDocIds) rows = rows.filter((r) => onlyDocIds.includes(r.doc_id));
  const trace: TraceStep[] = [];
  let tokens: number | undefined = 0;
  if (scope.origin) {
    // Shared notes need the `origin` filter field; older indexes get it added in place.
    await ensureVectorIndex(provider.dims);
    await ensureTextIndex();
  }
  if (rows.length) {
    // One Voyage request per batch of 64 chunks (see voyageApiProvider).
    await reserveVoyageRequests(Math.max(1, Math.ceil(rows.length / 64)));
    const embedded = await provider.embed(rows.map((r) => `${r.title}\n${r.text}`), "document");
    tokens = embedded.tokens;
    const docs: AtlasChunk[] = rows.map((r, i) => ({
      _id: r.id,
      docId: r.doc_id,
      title: r.title,
      text: r.text,
      sourceType: r.source_type,
      sourceRef: r.source_ref,
      tags: JSON.parse(r.tags) as string[],
      isDemo: Boolean(r.is_demo),
      ...(r.is_demo ? {} : { origin: scope.origin }),
      space: provider.space,
      embedding: Array.from(embedded.vectors[i]),
      embeddedWith: provider.model,
      updatedAt: ctx.now(),
    }));
    const write = await upsertChunks(docs);
    trace.push(
      { system: "Voyage AI", location: "cloud", operation: "Embed documents", detail: { model: provider.model, inputType: "document", dimensions: provider.dims, chunks: rows.length, tokens: tokens ?? 0 }, ms: embedded.ms },
      { system: "MongoDB Atlas", location: "cloud", operation: "Upsert text + metadata + vectors", detail: { collection: "knowledge_chunks", documents: write.upserted }, ms: write.ms },
    );
    const sharedDocs = [...new Set(rows.filter((r) => !r.is_demo).map((r) => r.doc_id))];
    tx(ctx.db, () => sharedDocs.forEach((id) => run(ctx.db, "UPDATE documents SET atlas_synced_at = ? WHERE id = ?", ctx.now().toISOString(), id)));
  }
  let removed = 0;
  if (scope.origin && !onlyDocIds) removed = await deleteStaleSharedChunks(scope.origin, sharedChunkIds);
  const demoChunks = rows.filter((r) => r.is_demo).length;
  const noteChunks = rows.length - demoChunks;
  const parts = [demoChunks ? `${demoChunks} demo chunks` : null, noteChunks ? `${noteChunks} chunks of your shared notes` : null].filter(Boolean);
  logActivity(ctx, {
    actor: "user",
    kind: "retrieval",
    outcome: "ok",
    summary: `Synced ${parts.join(" and ") || "nothing"} to Atlas (embedded with ${provider.model})${removed ? `; removed ${removed} no longer shared` : ""}`,
    detail: { tokens: tokens ?? 0, chunks: rows.length, removed },
  });
  return { chunks: rows.length, demoChunks, noteChunks, removed, tokens, trace };
}

/** Removes notes of this instance from Atlas (all of them when no ids are given). Throws if Atlas can't be reached. */
export async function removeFromAtlas(ctx: Ctx, docIds?: string[]) {
  if (!config().ATLAS_ENABLED) throw new UserError("Shared notes are in Atlas, but Atlas is not configured any more (ATLAS_ENABLED). Re-enable it so they can be removed there first.");
  try {
    return await deleteSharedChunks(atlasOrigin(ctx), docIds);
  } catch (err) {
    throw new UserError(`Couldn't remove shared notes from Atlas, so nothing was changed: ${safeError(err)}`, 502);
  }
}

/**
 * Shares one of your notes to Atlas (embedded with Voyage, then searchable there) or stops sharing it
 * (removed from Atlas first). Off by default; demo documents and the demo instance can't share.
 */
export async function setAtlasShare(ctx: Ctx, id: string, share: boolean) {
  if (appMode() === "demo") throw new UserError("Sharing your own notes is for the personal app, not the demo.");
  const doc = one<{ is_demo: number; atlas_share: number; atlas_synced_at: string | null }>(ctx.db, "SELECT is_demo, atlas_share, atlas_synced_at FROM documents WHERE id = ?", id);
  if (!doc) throw new UserError("Document not found", 404);
  if (doc.is_demo) throw new UserError("Demo documents are synced with the demo corpus, not shared one by one.");
  if (share) {
    const live = liveModeStatus(ctx);
    if (!live.enabled) throw new UserError(`Turn on Atlas live mode first (Under the hood): ${live.reasons.join("; ")}.`);
    run(ctx.db, "UPDATE documents SET atlas_share = 1 WHERE id = ?", id);
    try {
      const res = await syncCorpusToAtlas(ctx, [id]);
      return { shared: true, chunks: res.chunks };
    } catch (err) {
      // Not in Atlas after all: keep the switch truthful.
      run(ctx.db, "UPDATE documents SET atlas_share = 0 WHERE id = ?", id);
      throw err;
    }
  }
  if (doc.atlas_synced_at) await removeFromAtlas(ctx, [id]);
  run(ctx.db, "UPDATE documents SET atlas_share = 0, atlas_synced_at = NULL WHERE id = ?", id);
  logActivity(ctx, { actor: "user", kind: "retrieval", outcome: "ok", summary: "Stopped sharing a note to Atlas (removed there)", detail: { docId: id } });
  return { shared: false, chunks: 0 };
}

export async function retrieve(ctx: Ctx, rawInput: RetrieveInput, llm: LlmProvider = workLlm(ctx, "interactive"), actor = "user"): Promise<RetrievalResult> {
  const input = RetrieveInputSchema.parse(rawInput);
  const trace: TraceStep[] = [];
  let passages: Passage[] = [];
  let providerLabel = "";
  let runLabel: RetrievalResult["runLabel"] = "Local";

  if (input.provider === "lexical") {
    providerLabel = "BM25 keyword search (local)";
    const start = performance.now();
    const chunks = loadChunks(ctx, input.filters);
    const hits = bm25(input.query, chunks.map((c) => ({ id: c.id, text: `${c.title} ${c.text}` })), input.k);
    passages = hits.map((h, i) => toPassage(chunks.find((c) => c.id === h.id)!, h.score, "bm25", i + 1));
    trace.push({ system: "Local", location: "local", operation: "BM25 keyword ranking over SQLite chunks", detail: { candidates: chunks.length, returned: passages.length }, ms: Math.round(performance.now() - start) });
  } else if (input.provider === "local-semantic") {
    if (!nanoModelInstalled()) throw new UserError("Local semantic search needs voyage-4-nano. Run `npm run setup:local-embeddings` first.");
    const provider = nanoProvider();
    providerLabel = "voyage-4-nano embeddings + local vector scan";
    // Indexing is explicit (Knowledge → "Index locally"); search only covers chunks the user chose to index.
    const q = await provider.embed([input.query], "query");
    trace.push({ system: "Local", location: "local", operation: "Embed query with voyage-4-nano (open weights, CPU)", detail: { model: provider.model, dimensions: provider.dims, inputType: "query" }, ms: q.ms });
    const start = performance.now();
    const chunks = loadChunks(ctx, input.filters);
    const vecs = new Map(
      all<{ chunk_id: string; vector: Uint8Array }>(ctx.db, "SELECT chunk_id, vector FROM embeddings WHERE space = ?", provider.space).map((r) => [r.chunk_id, fromBlob(r.vector)]),
    );
    passages = chunks
      .filter((c) => vecs.has(c.id))
      .map((c) => ({ c, score: dot(q.vectors[0], vecs.get(c.id)!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.k)
      .map((h, i) => toPassage(h.c, h.score, "cosine", i + 1));
    const notIndexed = chunks.filter((c) => !vecs.has(c.id)).length;
    trace.push({
      system: "Local",
      location: "local",
      operation: "Exact cosine scan over SQLite vectors",
      detail: { indexedCandidates: chunks.length - notIndexed, notIndexed, filters: describeFilters(input.filters), returned: passages.length },
      ms: Math.round(performance.now() - start),
    });
  } else if (input.provider === "local-hybrid") {
    // Keyword and semantic rankings fused with Reciprocal Rank Fusion (score = Σ 1/(60 + rank)).
    // Exact words (names, numbers) and meaning both count; neither score scale needs calibrating.
    if (!nanoModelInstalled()) throw new UserError("Hybrid search needs voyage-4-nano. Run `npm run setup:local-embeddings` first.");
    const provider = nanoProvider();
    providerLabel = "Hybrid: BM25 + voyage-4-nano, reciprocal rank fusion";
    const chunks = loadChunks(ctx, input.filters);
    const depth = Math.max(input.k * 3, 10);
    let start = performance.now();
    const lexical = bm25(input.query, chunks.map((c) => ({ id: c.id, text: `${c.title} ${c.text}` })), depth).map((h) => h.id);
    trace.push({ system: "Local", location: "local", operation: "BM25 keyword ranking", detail: { candidates: chunks.length, returned: lexical.length }, ms: Math.round(performance.now() - start) });
    const q = await provider.embed([input.query], "query");
    trace.push({ system: "Local", location: "local", operation: "Embed query with voyage-4-nano", detail: { model: provider.model, dimensions: provider.dims }, ms: q.ms });
    start = performance.now();
    const vecs = new Map(all<{ chunk_id: string; vector: Uint8Array }>(ctx.db, "SELECT chunk_id, vector FROM embeddings WHERE space = ?", provider.space).map((r) => [r.chunk_id, fromBlob(r.vector)]));
    const semantic = chunks
      .filter((c) => vecs.has(c.id))
      .map((c) => ({ id: c.id, score: dot(q.vectors[0], vecs.get(c.id)!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, depth)
      .map((h) => h.id);
    const fused = reciprocalRankFusion([lexical, semantic]).slice(0, input.k);
    passages = fused.map((f, i) => toPassage(chunks.find((c) => c.id === f.id)!, f.score, `rrf (keyword #${f.ranks[0] ?? "–"}, semantic #${f.ranks[1] ?? "–"})`, i + 1));
    trace.push({ system: "Local", location: "local", operation: "Cosine scan + reciprocal rank fusion", detail: { keywordHits: lexical.length, semanticHits: semantic.length, k: 60, returned: passages.length }, ms: Math.round(performance.now() - start) });
  } else if (input.provider === "atlas-hybrid") {
    // One Atlas query fusing $vectorSearch and full-text $search with $rankFusion (MongoDB 8.0+).
    // The question is embedded locally (voyage-4-nano), so no Voyage API request is made.
    const live = liveModeStatus(ctx);
    if (!live.enabled) throw new UserError(`Atlas live mode is off: ${live.reasons.join("; ")}.`);
    if (!nanoModelInstalled()) throw new UserError("This mode needs voyage-4-nano. Run `npm run setup:local-embeddings` first.");
    runLabel = "Atlas hybrid live · local query embedding";
    const provider = nanoProvider();
    providerLabel = "Atlas $rankFusion: $vectorSearch + full-text $search";
    const q = await provider.embed([input.query], "query");
    trace.push({ system: "Local", location: "local", operation: "Embed query with voyage-4-nano (no Voyage API call)", detail: { model: provider.model, dimensions: provider.dims }, ms: q.ms });
    try {
      const hs = await atlasHybridSearch(q.vectors[0], input.query, provider.space, input.filters, input.k, atlasScope(ctx));
      trace.push({
        system: "MongoDB Atlas",
        location: "cloud",
        operation: "$rankFusion of $vectorSearch + $search (one query)",
        detail: { pipelines: "vector, text", depthEach: hs.depth, filters: describeFilters(input.filters), returned: hs.docs.length },
        ms: hs.ms,
      });
      passages = hs.docs.map((d, i) => {
        const ranks = Object.fromEntries((d.scoreDetails?.details ?? []).map((x) => [x.inputPipelineName, x.rank]));
        return {
          rank: i + 1,
          chunkId: d._id,
          docId: d.docId,
          title: d.title,
          sourceType: d.sourceType,
          sourceRef: d.sourceRef,
          tags: d.tags,
          text: d.text,
          score: Math.round(d.score * 10000) / 10000,
          scoreKind: `rrf (vector #${ranks.vector ?? "–"}, text #${ranks.text ?? "–"})`,
          flags: injectionFlags(d.text),
        };
      });
    } catch (err) {
      throw new UserError(liveFailure(err), 502);
    }
  } else if (input.provider === "atlas-nano") {
    // Cross-model retrieval: the Atlas corpus was embedded by the Voyage API (voyage-4-lite); the
    // question is embedded locally by voyage-4-nano. This works only because the voyage-4 family
    // shares one embedding space. No Voyage API request is made for the query.
    const live = liveModeStatus(ctx);
    if (!live.enabled) throw new UserError(`Atlas live mode is off: ${live.reasons.join("; ")}.`);
    if (!nanoModelInstalled()) throw new UserError("This mode needs voyage-4-nano. Run `npm run setup:local-embeddings` first.");
    runLabel = "Atlas live · local query embedding";
    const provider = nanoProvider();
    providerLabel = "voyage-4-nano query (local) + Atlas Vector Search";
    const q = await provider.embed([input.query], "query");
    trace.push({ system: "Local", location: "local", operation: "Embed query with voyage-4-nano (no Voyage API call)", detail: { model: provider.model, dimensions: provider.dims, space: provider.space }, ms: q.ms });
    try {
      const vs = await atlasVectorSearch(q.vectors[0], provider.space, input.filters, input.k, atlasScope(ctx));
      trace.push({
        system: "MongoDB Atlas",
        location: "cloud",
        operation: "$vectorSearch over vectors made by voyage-4-lite",
        detail: { index: "acc_knowledge_vector", numCandidates: vs.numCandidates, limit: input.k, filter: JSON.stringify(vs.filter), returned: vs.docs.length },
        ms: vs.ms,
      });
      passages = vs.docs.map((d, i) => ({
        rank: i + 1,
        chunkId: d._id,
        docId: d.docId,
        title: d.title,
        sourceType: d.sourceType,
        sourceRef: d.sourceRef,
        tags: d.tags,
        text: d.text,
        score: Math.round(d.score * 1000) / 1000,
        scoreKind: "vectorSearchScore",
        flags: injectionFlags(d.text),
      }));
    } catch (err) {
      throw new UserError(liveFailure(err), 502);
    }
  } else {
    const live = liveModeStatus(ctx);
    if (!live.enabled) throw new UserError(`Atlas + Voyage live mode is off: ${live.reasons.join("; ")}.`);
    runLabel = "Atlas + Voyage live";
    const provider = voyageApiProvider();
    providerLabel = `${provider.model} + Atlas Vector Search + ${config().VOYAGE_RERANK_MODEL}`;
    // Embed + rerank = two Voyage requests; reserve both up front so a search never stops half-way.
    await reserveVoyageRequests(2);
    try {
      const q = await provider.embed([input.query], "query");
      trace.push({ system: "Voyage AI", location: "cloud", operation: "Embed query", detail: { model: provider.model, inputType: "query", dimensions: provider.dims, tokens: q.tokens ?? 0 }, ms: q.ms });
      const candidates = Math.max(input.k * 3, 10);
      const vs = await atlasVectorSearch(q.vectors[0], provider.space, input.filters, candidates, atlasScope(ctx));
      trace.push({
        system: "MongoDB Atlas",
        location: "cloud",
        operation: "$vectorSearch with metadata pre-filter",
        detail: { index: "acc_knowledge_vector", numCandidates: vs.numCandidates, limit: candidates, filter: JSON.stringify(vs.filter), returned: vs.docs.length },
        ms: vs.ms,
      });
      const rr = vs.docs.length ? await voyageRerank(input.query, vs.docs.map((d) => `${d.title}\n${d.text}`), input.k) : { results: [], ms: 0, tokens: 0, model: config().VOYAGE_RERANK_MODEL };
      trace.push({ system: "Voyage AI", location: "cloud", operation: "Rerank candidates", detail: { model: rr.model, candidates: vs.docs.length, kept: rr.results.length, tokens: rr.tokens ?? 0 }, ms: rr.ms });
      passages = rr.results.map((r, i) => {
        const d = vs.docs[r.index];
        return {
          rank: i + 1,
          chunkId: d._id,
          docId: d.docId,
          title: d.title,
          sourceType: d.sourceType,
          sourceRef: d.sourceRef,
          tags: d.tags,
          text: d.text,
          score: Math.round(r.score * 1000) / 1000,
          scoreKind: `rerank (vector ${Math.round(d.score * 1000) / 1000})`,
          flags: injectionFlags(d.text),
        };
      });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 429 || /Status code: 429/.test(String(err))) throw new VoyageRateLimitError(60);
      throw new UserError(liveFailure(err), 502);
    }
  }

  const result: RetrievalResult = {
    id: newId("ret"),
    createdAt: ctx.now().toISOString(),
    query: input.query,
    provider: input.provider,
    runLabel,
    providerLabel,
    filters: input.filters,
    passages,
    trace,
  };

  if (input.answer) {
    result.answer = await groundedAnswer(input.question ?? input.query, passages, llm, trace);
  }

  run(ctx.db, "INSERT INTO retrieval_runs (id, created_at, query, provider, run_label, result) VALUES (?, ?, ?, ?, ?, ?)", result.id, result.createdAt, input.query, input.provider, runLabel, JSON.stringify(result));
  logActivity(ctx, {
    actor,
    kind: "retrieval",
    outcome: "ok",
    summary: `Knowledge search (${runLabel}, ${input.provider}): ${passages.length} passages`,
    detail: { retrievalId: result.id, provider: input.provider, flagged: passages.filter((p) => p.flags.length).length },
  });
  return result;
}

/** A search index made before notes could be shared lacks the `origin` filter until it is updated. */
function liveFailure(err: unknown) {
  if (/needs to be indexed as (filter|token)/i.test(String(err))) return "Live retrieval failed: the Atlas search indexes need the new `origin` filter. Run npm run atlas:setup (or Sync to Atlas), then give Atlas a minute to rebuild.";
  return `Live retrieval failed: ${safeError(err)}`;
}

/** Reciprocal Rank Fusion over ranked id lists; returns fused score and each list's 1-based rank. */
export function reciprocalRankFusion(lists: string[][], k = 60) {
  const scores = new Map<string, { score: number; ranks: (number | undefined)[] }>();
  lists.forEach((list, li) =>
    list.forEach((id, i) => {
      const e = scores.get(id) ?? { score: 0, ranks: lists.map(() => undefined) };
      e.score += 1 / (k + i + 1);
      e.ranks[li] = i + 1;
      scores.set(id, e);
    }),
  );
  return [...scores.entries()].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.score - a.score);
}

function describeFilters(f: { sourceType?: string; tags?: string[] }) {
  return [f.sourceType && `type=${f.sourceType}`, f.tags?.length && `tags∈[${f.tags.join(",")}]`].filter(Boolean).join(" ") || "none";
}

/**
 * Builds an answer only from retrieved passages. Passages are fenced as untrusted data; the
 * model has no tools, so a prompt injection can at worst distort the text, never act.
 */
function answerPrompt(query: string, passages: Passage[]) {
  const flagged = passages.filter((p) => p.flags.length).map((p) => p.rank);
  const system = [
    "You answer questions using only the numbered passages provided.",
    "Cite passages inline like [1] or [2]. If the passages do not contain the answer, say so.",
    "Keep the answer under 120 words.",
    UNTRUSTED_DATA_RULES,
  ].join("\n");
  // Trimmed passages keep the prompt small: on a CPU-only laptop, prompt length dominates latency.
  const user = `Question: ${query}\n\n${passages
    .slice(0, 4)
    .map((p) => fenceUntrusted(`[${p.rank}] ${p.title}`, p.text.slice(0, 600)))
    .join("\n\n")}`;
  const note = flagged.length ? `Passage ${flagged.map((n) => `[${n}]`).join(", ")} contained instruction-like text; it was treated as data only.` : undefined;
  return { system, user, note };
}

function extractiveAnswer(passages: Passage[], trace: TraceStep[], err: unknown): NonNullable<RetrievalResult["answer"]> {
  const sentences = passages[0].text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  trace.push({ system: "Local", location: "local", operation: "Extractive answer (LLM unavailable)", detail: { reason: err instanceof Error ? err.message.slice(0, 100) : "error" }, ms: 0 });
  return { text: `${sentences} [1]`, method: "extractive", note: "Local LLM unavailable — showing the most relevant passage instead of a generated answer." };
}

const NO_PASSAGES = { text: "No relevant passages were found, so there is nothing to ground an answer in.", method: "extractive" as const };

/**
 * Builds an answer only from retrieved passages. Passages are fenced as untrusted data; the
 * model has no tools, so a prompt injection can at worst distort the text, never act.
 */
export async function groundedAnswer(query: string, passages: Passage[], llm: LlmProvider, trace: TraceStep[]): Promise<RetrievalResult["answer"]> {
  if (!passages.length) return NO_PASSAGES;
  const { system, user, note } = answerPrompt(query, passages);
  try {
    const out = await llm.generate(system, user, { maxTokens: 220, timeoutMs: 900_000 });
    const cloud = out.model.startsWith("mistral-api:");
    trace.push({ system: cloud ? "Mistral API" : "Ollama", location: cloud ? "cloud" : "local", operation: "Grounded answer (no tools)", detail: { model: out.model, passages: passages.length }, ms: out.ms });
    return { text: out.text, method: "llm", model: out.model, note };
  } catch (err) {
    return extractiveAnswer(passages, trace, err);
  }
}

export type AnswerEvent = { type: "token"; text: string } | { type: "done"; result: RetrievalResult };

/**
 * Streaming variant for the UI: yields tokens as the local model writes them, then stores the
 * final answer on the retrieval run. Falls back to the extractive answer if the model fails
 * before producing anything; aborting (client disconnect) stops generation in Ollama too.
 */
export async function* streamAnswer(ctx: Ctx, retrievalId: string, signal?: AbortSignal, llm: LlmProvider = workLlm(ctx, "interactive")): AsyncGenerator<AnswerEvent> {
  const row = one<{ result: string }>(ctx.db, "SELECT result FROM retrieval_runs WHERE id = ?", retrievalId);
  if (!row) throw new UserError("Retrieval run not found", 404);
  const result = JSON.parse(row.result) as RetrievalResult;
  if (!result.passages.length) {
    result.answer = NO_PASSAGES;
  } else if (!llm.stream) {
    result.answer = await groundedAnswer(result.query, result.passages, llm, result.trace);
  } else {
    const { system, user, note } = answerPrompt(result.query, result.passages);
    const start = performance.now();
    let text = "";
    try {
      for await (const token of llm.stream(system, user, { maxTokens: 220, timeoutMs: 240_000, signal })) {
        text += token;
        yield { type: "token", text: token };
      }
      result.trace.push({ system: "Ollama", location: "local", operation: "Grounded answer, streamed (no tools)", detail: { model: llm.model ?? llm.id, passages: result.passages.length }, ms: Math.round(performance.now() - start) });
      result.answer = { text: text.trim(), method: "llm", model: llm.model, note };
    } catch (err) {
      if (signal?.aborted) return; // client went away: nothing to store
      result.answer = text ? { text: `${text.trim()} …`, method: "llm", model: llm.model, note: "Generation stopped early." } : extractiveAnswer(result.passages, result.trace, err);
    }
  }
  run(ctx.db, "UPDATE retrieval_runs SET result = ? WHERE id = ?", JSON.stringify(result), retrievalId);
  yield { type: "done", result };
}

/** Second, slower step: generate a grounded answer for a stored retrieval run with the local LLM. */
export async function answerRetrieval(ctx: Ctx, retrievalId: string, llm: LlmProvider = workLlm(ctx, "interactive")): Promise<RetrievalResult> {
  const row = one<{ result: string }>(ctx.db, "SELECT result FROM retrieval_runs WHERE id = ?", retrievalId);
  if (!row) throw new UserError("Retrieval run not found", 404);
  const result = JSON.parse(row.result) as RetrievalResult;
  result.answer = await groundedAnswer(result.query, result.passages, llm, result.trace);
  run(ctx.db, "UPDATE retrieval_runs SET result = ? WHERE id = ?", JSON.stringify(result), retrievalId);
  return result;
}

export function recentRetrievals(ctx: Ctx, limit = 10): RetrievalResult[] {
  return all<{ result: string }>(ctx.db, "SELECT result FROM retrieval_runs ORDER BY created_at DESC LIMIT ?", limit).map((r) => JSON.parse(r.result) as RetrievalResult);
}

export function knowledgeStats(ctx: Ctx) {
  return {
    // Counts match what this instance shows (the personal app hides the fictional notes).
    documents: one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM documents d WHERE 1 = 1${demoRowsFilter("d")}`)!.n,
    chunks: one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE 1 = 1${demoRowsFilter("d")}`)!.n,
    localVectors: one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.doc_id WHERE 1 = 1${demoRowsFilter("d")}`)!.n,
    nanoInstalled: nanoModelInstalled(),
  };
}
