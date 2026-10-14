import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadConfig } from "@/server/config";
import { all, one, setSetting } from "@/server/db";
import { buildTextScope, buildVectorFilter } from "@/server/retrieval/atlas";
import { addDocument, atlasScope, deleteDocument, setAtlasShare, syncCorpusToAtlas } from "@/server/retrieval/knowledge";
import { clearUserData } from "@/server/userData";
import { seededCtx } from "./helpers";

// Atlas and Voyage are replaced by recorders: these tests check what would be sent, never send it.
const atlas = vi.hoisted(() => ({
  upserted: [] as { _id: string; docId: string; isDemo: boolean; origin?: string }[],
  deleted: [] as { origin: string; docIds?: string[] }[],
  stale: [] as { origin: string; keep: string[] }[],
  failDelete: false,
}));
vi.mock("@/server/retrieval/atlas", async (orig) => ({
  ...(await orig<typeof import("@/server/retrieval/atlas")>()),
  upsertChunks: async (docs: { _id: string; docId: string; isDemo: boolean; origin?: string }[]) => {
    atlas.upserted.push(...docs);
    return { upserted: docs.length, ms: 1 };
  },
  deleteSharedChunks: async (origin: string, docIds?: string[]) => {
    if (atlas.failDelete) throw new Error("connection refused");
    atlas.deleted.push({ origin, docIds });
    return docIds?.length ?? 3;
  },
  deleteStaleSharedChunks: async (origin: string, keep: string[]) => {
    atlas.stale.push({ origin, keep });
    return 0;
  },
  ensureVectorIndex: async () => ({ created: false, updated: false, existingCount: 2 }),
  ensureTextIndex: async () => ({ created: false, updated: false, existingCount: 2 }),
}));
vi.mock("@/server/retrieval/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/server/retrieval/embeddings")>()),
  reserveVoyageRequests: async () => {},
  voyageApiProvider: () => ({
    model: "voyage-4-lite",
    space: "voyage-4@512",
    dims: 512,
    embed: async (texts: string[]) => ({ vectors: texts.map(() => new Float32Array(512)), tokens: texts.length * 10, ms: 1 }),
  }),
}));

function live(mode: "personal" | "demo" | "mixed") {
  vi.stubEnv("ACC_MODE", mode);
  vi.stubEnv("ATLAS_ENABLED", "true");
  vi.stubEnv("MONGODB_URI", "mongodb+srv://user:pass@cluster.example.net/");
  vi.stubEnv("VOYAGE_ENABLED", "true");
  vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
  reloadConfig();
  const ctx = seededCtx();
  setSetting(ctx.db, "showcase.live_consent", "true");
  return ctx;
}

beforeEach(() => {
  atlas.upserted.length = 0;
  atlas.deleted.length = 0;
  atlas.stale.length = 0;
  atlas.failDelete = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
});

describe("Atlas scope per instance", () => {
  it("the demo reads only demo chunks, the personal app only its own shared notes, mixed both", () => {
    expect(buildVectorFilter("s", {}, { demo: true })).toEqual({ $and: [{ space: "s" }, { isDemo: true }] });
    expect(buildVectorFilter("s", {}, { demo: false, origin: "abc" })).toEqual({ $and: [{ space: "s" }, { $and: [{ isDemo: false }, { origin: "abc" }] }] });
    expect(buildVectorFilter("s", { sourceType: "note" }, { demo: true, origin: "abc" }).$and[1]).toEqual({ $or: [{ isDemo: true }, { $and: [{ isDemo: false }, { origin: "abc" }] }] });
    // An empty scope matches nothing, never everything.
    expect(buildVectorFilter("s", {}, { demo: false }).$and[1]).toEqual({ isDemo: { $in: [] } });
    expect(JSON.stringify(buildTextScope({ demo: false, origin: "abc" }))).toContain('"origin"');
    expect(JSON.stringify(buildTextScope({ demo: true }))).not.toContain("origin");
  });

  it("each instance has its own stable origin id", () => {
    const a = live("personal");
    const first = atlasScope(a);
    expect(first).toMatchObject({ demo: false, origin: expect.stringMatching(/^[0-9a-f]{24}$/) });
    expect(atlasScope(a).origin).toBe(first.origin);
    expect(atlasScope(seededCtx()).origin).not.toBe(first.origin);
  });
});

describe("sharing your notes to Atlas", () => {
  it("is off by default: a sync in the personal app sends no note and no demo chunk", async () => {
    const ctx = live("personal");
    addDocument(ctx, { title: "Private", sourceType: "note", sourceRef: "x", content: "my private note" });
    const res = await syncCorpusToAtlas(ctx);
    expect(res.chunks).toBe(0);
    expect(atlas.upserted).toEqual([]);
    // Nothing is shared, so anything of this instance still in Atlas is stale.
    expect(atlas.stale).toEqual([{ origin: atlasScope(ctx).origin, keep: [] }]);
  });

  it("a shared note is embedded and stored with this instance's origin, and marked as synced", async () => {
    const ctx = live("personal");
    const id = addDocument(ctx, { title: "Bike", sourceType: "note", sourceRef: "x", content: "Drivetrain tune-up on Friday" });
    await setAtlasShare(ctx, id, true);
    expect(atlas.upserted).toHaveLength(1);
    expect(atlas.upserted[0]).toMatchObject({ docId: id, isDemo: false, origin: atlasScope(ctx).origin });
    expect(one<{ atlas_share: number; atlas_synced_at: string | null }>(ctx.db, "SELECT atlas_share, atlas_synced_at FROM documents WHERE id = ?", id)).toMatchObject({ atlas_share: 1, atlas_synced_at: expect.any(String) });
  });

  it("unsharing removes the note from Atlas first; if that fails, nothing changes", async () => {
    const ctx = live("personal");
    const id = addDocument(ctx, { title: "Bike", sourceType: "note", sourceRef: "x", content: "Drivetrain tune-up" });
    await setAtlasShare(ctx, id, true);
    atlas.failDelete = true;
    await expect(setAtlasShare(ctx, id, false)).rejects.toThrow(/nothing was changed/);
    expect(one<{ atlas_share: number }>(ctx.db, "SELECT atlas_share FROM documents WHERE id = ?", id)!.atlas_share).toBe(1);
    atlas.failDelete = false;
    await setAtlasShare(ctx, id, false);
    expect(atlas.deleted).toEqual([{ origin: atlasScope(ctx).origin, docIds: [id] }]);
    expect(one<{ atlas_share: number; atlas_synced_at: string | null }>(ctx.db, "SELECT atlas_share, atlas_synced_at FROM documents WHERE id = ?", id)).toEqual({ atlas_share: 0, atlas_synced_at: null });
  });

  it("deleting a shared note, or clearing your data, removes it from Atlas before anything local", async () => {
    const ctx = live("personal");
    const a = addDocument(ctx, { title: "A", sourceType: "note", sourceRef: "x", content: "first note" });
    const b = addDocument(ctx, { title: "B", sourceType: "note", sourceRef: "x", content: "second note" });
    await setAtlasShare(ctx, a, true);
    await setAtlasShare(ctx, b, true);
    await deleteDocument(ctx, a);
    expect(atlas.deleted.at(-1)).toEqual({ origin: atlasScope(ctx).origin, docIds: [a] });

    atlas.failDelete = true;
    await expect(clearUserData(ctx)).rejects.toThrow(/Atlas/);
    expect(one(ctx.db, "SELECT 1 FROM documents WHERE id = ?", b)).toBeTruthy();
    atlas.failDelete = false;
    await clearUserData(ctx);
    expect(atlas.deleted.at(-1)).toEqual({ origin: atlasScope(ctx).origin, docIds: undefined });
    expect(all(ctx.db, "SELECT id FROM documents WHERE is_demo = 0")).toEqual([]);
  });

  it("needs live mode, and is refused for demo documents and in the demo instance", async () => {
    const ctx = live("personal");
    setSetting(ctx.db, "showcase.live_consent", "false");
    const id = addDocument(ctx, { title: "N", sourceType: "note", sourceRef: "x", content: "note" });
    await expect(setAtlasShare(ctx, id, true)).rejects.toThrow(/live mode/i);
    expect(one<{ atlas_share: number }>(ctx.db, "SELECT atlas_share FROM documents WHERE id = ?", id)!.atlas_share).toBe(0);

    const demoDoc = one<{ id: string }>(ctx.db, "SELECT id FROM documents WHERE is_demo = 1 LIMIT 1")!.id;
    setSetting(ctx.db, "showcase.live_consent", "true");
    await expect(setAtlasShare(ctx, demoDoc, true)).rejects.toThrow(/Demo documents/);

    const demo = live("demo");
    const note = addDocument(demo, { title: "N", sourceType: "note", sourceRef: "x", content: "note" });
    await expect(setAtlasShare(demo, note, true)).rejects.toThrow(/personal app/);
    await syncCorpusToAtlas(demo);
    // The demo syncs its fictional corpus only, without an origin, and never touches shared notes.
    expect(atlas.upserted.length).toBeGreaterThan(0);
    expect(atlas.upserted.every((c) => c.isDemo && c.origin === undefined)).toBe(true);
    expect(atlas.stale).toEqual([]);
  });
});
