import type { MongoClient, Collection } from "mongodb";
import { config } from "../config";
import { UserError } from "../errors";

/**
 * Optional MongoDB Atlas provider: stores knowledge chunks (text, metadata, vectors) and answers
 * semantic queries with $vectorSearch. Only used when ATLAS_ENABLED=true and the user has confirmed
 * live mode in the UI. It holds the fictional demo corpus, plus the user's own notes only when they
 * share a note explicitly (never email). Shared notes carry the instance's `origin`, so another
 * instance on the same cluster (the demo, a test run) never sees or deletes them.
 */

export const ATLAS_COLLECTION = "knowledge_chunks";
export const ATLAS_INDEX = "acc_knowledge_vector";
export const ATLAS_TEXT_INDEX = "acc_knowledge_text";

export interface AtlasChunk {
  _id: string;
  docId: string;
  title: string;
  text: string;
  sourceType: string;
  sourceRef: string;
  tags: string[];
  isDemo: boolean;
  /** Instance that shared a personal note; absent on demo chunks, which every instance may read. */
  origin?: string;
  space: string;
  embedding: number[];
  embeddedWith: string;
  updatedAt: Date;
}

const globalForMongo = globalThis as unknown as { __accMongo?: Promise<MongoClient> };

async function client(): Promise<MongoClient> {
  const c = config();
  if (!c.ATLAS_ENABLED || !c.MONGODB_URI) throw new UserError("MongoDB Atlas is not configured (ATLAS_ENABLED / MONGODB_URI).");
  globalForMongo.__accMongo ??= (async () => {
    const { MongoClient } = await import("mongodb");
    const mc = new MongoClient(c.MONGODB_URI!, { appName: "agent-command-center", serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    return mc.connect();
  })().catch((err) => {
    globalForMongo.__accMongo = undefined;
    throw err;
  });
  return globalForMongo.__accMongo;
}

export async function chunksCollection(): Promise<Collection<AtlasChunk>> {
  return (await client()).db(config().ATLAS_DB_NAME).collection<AtlasChunk>(ATLAS_COLLECTION);
}

export function vectorIndexDefinition(dims: number) {
  return {
    fields: [
      { type: "vector", path: "embedding", numDimensions: dims, similarity: "dotProduct" },
      { type: "filter", path: "space" },
      { type: "filter", path: "sourceType" },
      { type: "filter", path: "tags" },
      { type: "filter", path: "isDemo" },
      { type: "filter", path: "origin" },
    ],
  };
}

export interface AtlasStatus {
  reachable: boolean;
  indexStatus?: string;
  indexQueryable?: boolean;
  chunkCount?: number;
  searchIndexCount?: number;
  error?: string;
}

export async function atlasStatus(): Promise<AtlasStatus> {
  try {
    const coll = await chunksCollection();
    const [count, indexes] = await Promise.all([coll.countDocuments({}), coll.listSearchIndexes().toArray()]);
    const ours = indexes.find((i) => i.name === ATLAS_INDEX) as { status?: string; queryable?: boolean } | undefined;
    return {
      reachable: true,
      chunkCount: count,
      searchIndexCount: indexes.length,
      indexStatus: ours?.status as string | undefined,
      indexQueryable: ours?.queryable as boolean | undefined,
    };
  } catch (err) {
    return { reachable: false, error: safeError(err) };
  }
}

/** Never leak a connection string or credentials through an error message. */
export function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, "mongodb://[redacted]").replace(/(api[_-]?key|token)\S*/gi, "[redacted]").slice(0, 300);
}

export async function upsertChunks(chunks: AtlasChunk[]) {
  const coll = await chunksCollection();
  if (!chunks.length) return { upserted: 0, ms: 0 };
  const start = performance.now();
  const res = await coll.bulkWrite(
    chunks.map((c) => ({ replaceOne: { filter: { _id: c._id }, replacement: c, upsert: true } })),
    { ordered: false },
  );
  return { upserted: res.upsertedCount + res.modifiedCount, ms: Math.round(performance.now() - start) };
}

export interface AtlasFilter {
  sourceType?: string;
  tags?: string[];
}

/** Which chunks an instance may read: the demo corpus, its own shared notes, or both (mixed mode). */
export interface AtlasScope {
  demo: boolean;
  /** This instance's origin id when its shared notes are in scope. */
  origin?: string;
}

function scopeClause(scope: AtlasScope): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (scope.demo) parts.push({ isDemo: true });
  if (scope.origin) parts.push({ $and: [{ isDemo: false }, { origin: scope.origin }] });
  // Nothing in scope must match nothing, never everything.
  if (!parts.length) return { isDemo: { $in: [] } };
  return parts.length === 1 ? parts[0] : { $or: parts };
}

export function buildVectorFilter(space: string, f: AtlasFilter, scope: AtlasScope = { demo: true }) {
  const clauses: Record<string, unknown>[] = [{ space }, scopeClause(scope)];
  if (f.sourceType) clauses.push({ sourceType: f.sourceType });
  if (f.tags?.length) clauses.push({ tags: { $in: f.tags } });
  return { $and: clauses };
}

/** The same scope for the full-text $search pipeline (compound filter clauses). */
export function buildTextScope(scope: AtlasScope): Record<string, unknown> {
  const demo = { equals: { path: "isDemo", value: true } };
  const own = scope.origin ? { compound: { filter: [{ equals: { path: "isDemo", value: false } }, { equals: { path: "origin", value: scope.origin } }] } } : null;
  if (scope.demo && own) return { compound: { should: [demo, own], minimumShouldMatch: 1 } };
  if (own) return own;
  if (scope.demo) return demo;
  return { compound: { filter: [{ equals: { path: "isDemo", value: true } }, { equals: { path: "isDemo", value: false } }] } };
}

export async function atlasVectorSearch(queryVector: Float32Array, space: string, filter: AtlasFilter, limit: number, scope: AtlasScope = { demo: true }) {
  const coll = await chunksCollection();
  const vectorFilter = buildVectorFilter(space, filter, scope);
  const pipeline = [
    {
      $vectorSearch: {
        index: ATLAS_INDEX,
        path: "embedding",
        queryVector: Array.from(queryVector),
        numCandidates: Math.max(limit * 20, 100),
        limit,
        filter: vectorFilter,
      },
    },
    { $project: { embedding: 0, score: { $meta: "vectorSearchScore" } } },
  ];
  const start = performance.now();
  const docs = (await coll.aggregate(pipeline).toArray()) as (Omit<AtlasChunk, "embedding"> & { score: number })[];
  return { docs, ms: Math.round(performance.now() - start), filter: vectorFilter, numCandidates: Math.max(limit * 20, 100) };
}

export async function ensureVectorIndex(dims: number) {
  // Search indexes can only be created on an existing collection.
  const db = (await client()).db(config().ATLAS_DB_NAME);
  if (!(await db.listCollections({ name: ATLAS_COLLECTION }).hasNext())) await db.createCollection(ATLAS_COLLECTION);
  const coll = await chunksCollection();
  const existing = await coll.listSearchIndexes().toArray();
  const ours = existing.find((i) => i.name === ATLAS_INDEX) as { latestDefinition?: { fields?: { path?: string }[] } } | undefined;
  if (ours) {
    // Indexes made before notes could be shared lack the `origin` filter: add it in place.
    const hasOrigin = ours.latestDefinition?.fields?.some((f) => f.path === "origin");
    if (!hasOrigin) await coll.updateSearchIndex(ATLAS_INDEX, vectorIndexDefinition(dims));
    return { created: false, updated: !hasOrigin, existingCount: existing.length };
  }
  await coll.createSearchIndex({ name: ATLAS_INDEX, type: "vectorSearch", definition: vectorIndexDefinition(dims) });
  return { created: true, updated: false, existingCount: existing.length + 1 };
}

/** Removes this instance's shared notes from Atlas: some documents, or all of them. Demo chunks are never touched. */
export async function deleteSharedChunks(origin: string, docIds?: string[]) {
  const coll = await chunksCollection();
  const filter: Record<string, unknown> = { isDemo: false, origin };
  if (docIds) filter.docId = { $in: docIds };
  const res = await coll.deleteMany(filter);
  return res.deletedCount;
}

/** Shared notes in Atlas that are no longer shared locally (unshared or deleted while offline). */
export async function deleteStaleSharedChunks(origin: string, keepChunkIds: string[]) {
  const coll = await chunksCollection();
  const res = await coll.deleteMany({ isDemo: false, origin, _id: { $nin: keepChunkIds } });
  return res.deletedCount;
}

/** Atlas Search (full-text) index used by the hybrid mode. Filter fields are tokens/booleans for `equals`/`in`. */
export function textIndexDefinition() {
  return {
    mappings: {
      dynamic: false,
      fields: {
        title: { type: "string", analyzer: "lucene.english" },
        text: { type: "string", analyzer: "lucene.english" },
        sourceType: { type: "token" },
        tags: { type: "token" },
        isDemo: { type: "boolean" },
        origin: { type: "token" },
      },
    },
  };
}

export async function ensureTextIndex() {
  const coll = await chunksCollection();
  const existing = await coll.listSearchIndexes().toArray();
  const ours = existing.find((i) => i.name === ATLAS_TEXT_INDEX) as { latestDefinition?: { mappings?: { fields?: Record<string, unknown> } } } | undefined;
  if (ours) {
    const hasOrigin = Boolean(ours.latestDefinition?.mappings?.fields?.origin);
    if (!hasOrigin) await coll.updateSearchIndex(ATLAS_TEXT_INDEX, textIndexDefinition());
    return { created: false, updated: !hasOrigin, existingCount: existing.length };
  }
  await coll.createSearchIndex({ name: ATLAS_TEXT_INDEX, type: "search", definition: textIndexDefinition() });
  return { created: true, updated: false, existingCount: existing.length + 1 };
}

/**
 * Hybrid retrieval in a single Atlas query: $rankFusion combines a $vectorSearch pipeline and a
 * full-text $search pipeline with Reciprocal Rank Fusion (MongoDB 8.0+). Same metadata filters in both.
 */
export async function atlasHybridSearch(queryVector: Float32Array, query: string, space: string, filter: AtlasFilter, limit: number, scope: AtlasScope = { demo: true }) {
  const coll = await chunksCollection();
  const vectorFilter = buildVectorFilter(space, filter, scope);
  const textFilter: Record<string, unknown>[] = [buildTextScope(scope)];
  if (filter.sourceType) textFilter.push({ equals: { path: "sourceType", value: filter.sourceType } });
  if (filter.tags?.length) textFilter.push({ in: { path: "tags", value: filter.tags } });
  const depth = Math.max(limit * 3, 10);
  const pipeline = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: { index: ATLAS_INDEX, path: "embedding", queryVector: Array.from(queryVector), numCandidates: Math.max(depth * 10, 100), limit: depth, filter: vectorFilter } }],
            text: [{ $search: { index: ATLAS_TEXT_INDEX, compound: { must: [{ text: { query: query.slice(0, 300), path: ["title", "text"] } }], filter: textFilter } } }, { $limit: depth }],
          },
        },
        scoreDetails: true,
      },
    },
    { $limit: limit },
    { $project: { embedding: 0, score: { $meta: "score" }, scoreDetails: { $meta: "scoreDetails" } } },
  ];
  const start = performance.now();
  const docs = (await coll.aggregate(pipeline).toArray()) as (Omit<AtlasChunk, "embedding"> & { score: number; scoreDetails?: { details?: { inputPipelineName?: string; rank?: number }[] } })[];
  return { docs, ms: Math.round(performance.now() - start), depth };
}
