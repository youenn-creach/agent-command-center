import { UserError } from "../errors";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { config } from "../config";

/**
 * Embedding providers. Both produce vectors in the Voyage 4 shared embedding space
 * (voyage-4-nano locally, voyage-4-lite/voyage-4/voyage-4-large via the API), truncated to the
 * same Matryoshka dimension. Vectors are stored per `space`, so a provider is never
 * silently mixed with an incompatible one.
 */

export type EmbedKind = "query" | "document";

export interface EmbedResult {
  vectors: Float32Array[];
  tokens?: number;
  ms: number;
}

export interface EmbeddingProvider {
  id: "voyage-nano-local" | "voyage-api";
  label: string;
  model: string;
  dims: number;
  space: string;
  location: "local" | "cloud";
  embed(texts: string[], kind: EmbedKind): Promise<EmbedResult>;
}

export function spaceFor(dims: number) {
  return `voyage4-${dims}`;
}

export const NANO_MODEL_ID = "onnx-community/voyage-4-nano-ONNX";
export const NANO_DTYPE = "q8"; // ~420 MB quantized weights; fp32 would be ~1.4 GB.
/**
 * Pinned download: this exact commit of the Hugging Face repository, and these exact files
 * (SHA-256 published by Hugging Face for the weights, computed from the same commit for the small
 * JSON files). A changed or tampered download is refused instead of loaded.
 */
export const NANO_REVISION = "fb6f32cceb63b6eac92e1fdc08e00d03c41cdf5a";
export const NANO_FILES: Record<string, string> = {
  "config.json": "0a37f11f814acca77619c3039409743285d15690eb33493d077784e653e9a524",
  "tokenizer.json": "c40c3736449ad0f4084a187dfe16f6850b2a2933dfe041394f850608b2890140",
  "tokenizer_config.json": "ca057610cc7151781181806adda7ac01a2b09c4d4756983a9e49d69252689522",
  "onnx/model_quantized.onnx": "e2999ae63b575e34b7bef6a513f48c7f7701cebfb1bfffcb9db23ab0db324157",
  "onnx/model_quantized.onnx_data": "db94fc1655db1a1b55f67f7019ebbd803142f54e1bd83cfd1c2d6faadd6a648c",
};
const NANO_PROMPTS: Record<EmbedKind, string> = {
  query: "Represent the query for retrieving supporting documents: ",
  document: "Represent the document for retrieval: ",
};

export function modelCacheDir() {
  return process.env.ACC_MODEL_DIR ?? path.join(process.cwd(), "models");
}

export function nanoModelInstalled(): boolean {
  return existsSync(path.join(modelCacheDir(), NANO_MODEL_ID, "onnx", "model_quantized.onnx_data"));
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

const markerPath = () => path.join(modelCacheDir(), NANO_MODEL_ID, ".verified.json");
/** Size and modification time of each pinned file: cheap to compare, changes if a file is replaced. */
function fileStamps() {
  const dir = path.join(modelCacheDir(), NANO_MODEL_ID);
  return Object.fromEntries(Object.keys(NANO_FILES).map((f) => {
    const st = statSync(path.join(dir, f));
    return [f, `${st.size}:${Math.round(st.mtimeMs)}`];
  }));
}

/**
 * Checks every pinned file against its SHA-256. Hashing ~420 MB takes a few seconds, so a passing
 * check is remembered with each file's size and modification time; later loads only compare those.
 */
export async function verifyNanoModel(force = false): Promise<{ ok: boolean; problems: string[] }> {
  const dir = path.join(modelCacheDir(), NANO_MODEL_ID);
  const missing = Object.keys(NANO_FILES).filter((f) => !existsSync(path.join(dir, f)));
  if (missing.length) return { ok: false, problems: missing.map((f) => `${f} is missing`) };
  const stamps = JSON.stringify({ revision: NANO_REVISION, files: fileStamps() });
  if (!force) {
    try {
      if (readFileSync(markerPath(), "utf8") === stamps) return { ok: true, problems: [] };
    } catch {
      // no marker yet: hash below
    }
  }
  const problems: string[] = [];
  for (const [f, expected] of Object.entries(NANO_FILES)) {
    if ((await sha256File(path.join(dir, f))) !== expected) problems.push(`${f} does not match the pinned SHA-256`);
  }
  if (problems.length) rmSync(markerPath(), { force: true });
  else writeFileSync(markerPath(), stamps);
  return { ok: !problems.length, problems };
}

function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

type Extractor = ((text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>) & { dispose?: () => Promise<void> };
let nanoPipeline: Promise<Extractor> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
const NANO_IDLE_MS = 3 * 60_000;

/** Frees the ~0.5 GB model after a few idle minutes; the next search reloads it (~2–3 s). */
function scheduleNanoUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const p = nanoPipeline;
    nanoPipeline = undefined;
    void p?.then((e) => e.dispose?.()).catch(() => {});
  }, NANO_IDLE_MS);
  idleTimer.unref();
}

/** Frees the in-process embedding model now (Settings → offload). Returns whether it was loaded. */
export async function unloadNanoModel(): Promise<boolean> {
  clearTimeout(idleTimer);
  const p = nanoPipeline;
  nanoPipeline = undefined;
  if (!p) return false;
  await p.then((e) => e.dispose?.()).catch(() => {});
  return true;
}

/** Loads the already-downloaded model. Never downloads at runtime: `npm run setup:local-embeddings` does that, explicitly. */
async function loadNano(allowDownload = false): Promise<Extractor> {
  if (!allowDownload && !nanoModelInstalled()) {
    throw new UserError("voyage-4-nano is not installed. Run `npm run setup:local-embeddings` (one-time ~420 MB download) to enable local semantic search.");
  }
  nanoPipeline ??= (async () => {
    if (!allowDownload) {
      const check = await verifyNanoModel();
      if (!check.ok) throw new UserError(`voyage-4-nano failed its integrity check (${check.problems.join("; ")}). Delete ${path.join(modelCacheDir(), NANO_MODEL_ID)} and run \`npm run setup:local-embeddings\` again.`);
    }
    const t = await import("@huggingface/transformers");
    t.env.cacheDir = modelCacheDir();
    t.env.allowRemoteModels = allowDownload;
    t.env.allowLocalModels = true;
    const extractor = await t.pipeline("feature-extraction", NANO_MODEL_ID, { dtype: NANO_DTYPE, device: "cpu", revision: NANO_REVISION });
    return extractor as unknown as Extractor;
  })().catch((err) => {
    nanoPipeline = undefined;
    throw err;
  });
  return nanoPipeline;
}

/** Downloads the pinned revision, then refuses (and deletes) it unless every file matches its SHA-256. */
export async function downloadNanoModel() {
  const extractor = await loadNano(true);
  const check = await verifyNanoModel(true);
  if (!check.ok) {
    await unloadNanoModel();
    rmSync(path.join(modelCacheDir(), NANO_MODEL_ID), { recursive: true, force: true });
    throw new Error(`Downloaded model failed its integrity check and was deleted: ${check.problems.join("; ")}`);
  }
  await extractor("warm-up", { pooling: "mean", normalize: true });
}

export function nanoProvider(dims = config().VOYAGE_DIMENSIONS): EmbeddingProvider {
  return {
    id: "voyage-nano-local",
    label: "voyage-4-nano (local, open weights)",
    model: "voyage-4-nano",
    dims,
    space: spaceFor(dims),
    location: "local",
    async embed(texts, kind) {
      const start = performance.now();
      const extractor = await loadNano();
      scheduleNanoUnload();
      const vectors: Float32Array[] = [];
      for (const text of texts) {
        const out = await extractor(NANO_PROMPTS[kind] + text, { pooling: "mean", normalize: true });
        scheduleNanoUnload(); // keep the model while a long indexing run is still using it
        // Matryoshka truncation, then re-normalise so cosine == dot product.
        vectors.push(l2normalize(Float32Array.from(out.data.slice(0, dims))));
      }
      return { vectors, ms: Math.round(performance.now() - start) };
    },
  };
}

export function voyageApiProvider(): EmbeddingProvider {
  const c = config();
  return {
    id: "voyage-api",
    label: `${c.VOYAGE_EMBED_MODEL} (Voyage AI API)`,
    model: c.VOYAGE_EMBED_MODEL,
    dims: c.VOYAGE_DIMENSIONS,
    space: spaceFor(c.VOYAGE_DIMENSIONS),
    location: "cloud",
    async embed(texts, kind) {
      const start = performance.now();
      const vectors: Float32Array[] = [];
      let tokens = 0;
      for (let i = 0; i < texts.length; i += 64) {
        const res = await voyagePost<{ data?: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } }>("/embeddings", {
          input: texts.slice(i, i + 64),
          model: c.VOYAGE_EMBED_MODEL,
          input_type: kind,
          output_dimension: c.VOYAGE_DIMENSIONS,
        });
        const batch = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
        if (batch.length !== Math.min(64, texts.length - i)) throw new Error(`Voyage AI returned ${batch.length} embeddings for ${Math.min(64, texts.length - i)} texts`);
        for (const item of batch) vectors.push(l2normalize(Float32Array.from(item.embedding)));
        tokens += res.usage?.total_tokens ?? 0;
      }
      return { vectors, tokens, ms: Math.round(performance.now() - start) };
    },
  };
}

export class VoyageRateLimitError extends Error {
  readonly code = "VOYAGE_RATE_LIMIT";
  constructor(readonly retryInSeconds: number) {
    super(`Voyage AI rate limit (${config().VOYAGE_MAX_RPM} requests/min on this account). Try again in ${retryInSeconds} s.`);
  }
}

const voyageCalls: number[] = [];

/**
 * Client-side request budget for the Voyage API, so the app stays inside the account's rate limit
 * instead of collecting HTTP 429s. Reserves `n` request slots at once (a live search needs two:
 * embed + rerank) so a search never stops half-way. Interactive callers fail fast with a
 * retry hint; batch callers (the eval script sets ACC_VOYAGE_WAIT=1) wait for a free slot.
 */
export async function reserveVoyageRequests(n: number, wait = process.env.ACC_VOYAGE_WAIT === "1"): Promise<void> {
  const rpm = config().VOYAGE_MAX_RPM;
  if (n > rpm) throw new UserError(`This needs ${n} Voyage requests at once, above your limit of ${rpm}/min (VOYAGE_MAX_RPM).`);
  for (;;) {
    const now = Date.now();
    while (voyageCalls.length && now - voyageCalls[0] >= 60_000) voyageCalls.shift();
    if (voyageCalls.length + n <= rpm) {
      for (let i = 0; i < n; i++) voyageCalls.push(now);
      return;
    }
    const waitMs = 60_000 - (now - voyageCalls[voyageCalls.length + n - rpm - 1]) + 250;
    if (!wait) throw new VoyageRateLimitError(Math.ceil(waitMs / 1000));
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

const VOYAGE_API = "https://api.voyageai.com/v1";

/**
 * The two Voyage AI endpoints this app uses, called directly: a fixed host, the key in a header,
 * 20 s timeout, no retries (the rate budget above decides when to call) and no redirects.
 * An error keeps the HTTP status in `statusCode`, so a 429 becomes a rate-limit hint upstream.
 */
async function voyagePost<T>(endpoint: "/embeddings" | "/rerank", body: Record<string, unknown>): Promise<T> {
  const c = config();
  if (!c.VOYAGE_ENABLED || !c.VOYAGE_API_KEY) throw new UserError("Voyage AI is not configured (VOYAGE_ENABLED / VOYAGE_API_KEY).");
  const res = await voyageFetch(`${VOYAGE_API}${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.VOYAGE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw Object.assign(new Error(`Voyage AI returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`), { statusCode: res.status });
  }
  return (await res.json()) as T;
}

let voyageFetch: typeof fetch = (input, init) => fetch(input, init);
/** Tests replace the network call. */
export function setVoyageFetch(f: typeof fetch) {
  voyageFetch = f;
}

export async function voyageRerank(query: string, documents: string[], topK: number) {
  const c = config();
  const start = performance.now();
  const res = await voyagePost<{ data?: { index: number; relevance_score: number }[]; usage?: { total_tokens?: number } }>("/rerank", {
    query,
    documents,
    model: c.VOYAGE_RERANK_MODEL,
    top_k: topK,
  });
  return {
    results: (res.data ?? []).map((d) => ({ index: d.index, score: d.relevance_score })),
    tokens: res.usage?.total_tokens,
    ms: Math.round(performance.now() - start),
    model: c.VOYAGE_RERANK_MODEL,
  };
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
