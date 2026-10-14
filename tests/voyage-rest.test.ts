import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadConfig } from "@/server/config";
import { NANO_FILES, NANO_MODEL_ID, setVoyageFetch, verifyNanoModel, voyageApiProvider, voyageRerank } from "@/server/retrieval/embeddings";

function voyageOn() {
  vi.stubEnv("VOYAGE_ENABLED", "true");
  vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
  reloadConfig();
}
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
  setVoyageFetch((input, init) => fetch(input, init));
});

describe("Voyage AI over HTTPS (no SDK)", () => {
  it("embeds with the documented fields, keeps input order, and sends the key only to api.voyageai.com", async () => {
    voyageOn();
    const calls: { url: string; init: RequestInit }[] = [];
    setVoyageFetch(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      // Out of order on purpose: results are matched by index, not position.
      return Response.json({ data: [{ index: 1, embedding: [0, 3, 4] }, { index: 0, embedding: [5, 0, 0] }], usage: { total_tokens: 12 } });
    });
    const out = await voyageApiProvider().embed(["first", "second"], "document");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(calls[0].init.redirect).toBe("error");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer test-voyage-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ input: ["first", "second"], model: "voyage-4-lite", input_type: "document", output_dimension: 512 });
    expect(Array.from(out.vectors[0])).toEqual([1, 0, 0]); // index 0, normalised
    Array.from(out.vectors[1]).forEach((x, i) => expect(x).toBeCloseTo([0, 0.6, 0.8][i], 6));
    expect(out.tokens).toBe(12);
  });

  it("reranks, and keeps the HTTP status so a 429 becomes a rate-limit hint", async () => {
    voyageOn();
    setVoyageFetch(async () => Response.json({ data: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }], usage: { total_tokens: 30 } }));
    const rr = await voyageRerank("q", ["a", "b", "c"], 2);
    expect(rr.results).toEqual([{ index: 2, score: 0.9 }, { index: 0, score: 0.4 }]);
    expect(rr.tokens).toBe(30);

    setVoyageFetch(async () => new Response("rate limited", { status: 429 }));
    await expect(voyageRerank("q", ["a"], 1)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("refuses to call Voyage when it is not configured", async () => {
    const spy = vi.fn();
    setVoyageFetch(spy);
    await expect(voyageRerank("q", ["a"], 1)).rejects.toThrow(/not configured/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("voyage-4-nano integrity", () => {
  it("reports missing files, and refuses files that don't match the pinned SHA-256", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "acc-models-"));
    vi.stubEnv("ACC_MODEL_DIR", dir);
    expect((await verifyNanoModel()).problems).toContain("onnx/model_quantized.onnx is missing");
    for (const f of Object.keys(NANO_FILES)) {
      mkdirSync(path.dirname(path.join(dir, NANO_MODEL_ID, f)), { recursive: true });
      writeFileSync(path.join(dir, NANO_MODEL_ID, f), "tampered");
    }
    const check = await verifyNanoModel();
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(Object.keys(NANO_FILES).length);
  });
});
