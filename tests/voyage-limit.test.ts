import { describe, expect, it } from "vitest";
import { reserveVoyageRequests, VoyageRateLimitError } from "@/server/retrieval/embeddings";

describe("Voyage request budget", () => {
  it("never reserves more requests per minute than the account allows (default 3)", async () => {
    await reserveVoyageRequests(2, false); // a live search: embed + rerank
    await expect(reserveVoyageRequests(2, false)).rejects.toThrow(VoyageRateLimitError);
    await reserveVoyageRequests(1, false); // the third slot is still usable
    const err = await reserveVoyageRequests(1, false).catch((e) => e);
    expect(err).toBeInstanceOf(VoyageRateLimitError);
    expect(err.retryInSeconds).toBeGreaterThan(0);
    expect(err.retryInSeconds).toBeLessThanOrEqual(61);
  });

  it("refuses a reservation larger than the per-minute limit instead of waiting forever", async () => {
    await expect(reserveVoyageRequests(4, true)).rejects.toThrow(/above your limit/);
  });
});
