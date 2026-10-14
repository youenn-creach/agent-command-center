import { describe, expect, it } from "vitest";
import { friendlyName, judgeBottleneck, systemResources } from "@/server/resources";

const base = { cpu: { percent: 20, cores: 4 }, memory: { usedMB: 5000, totalMB: 11800, availableMB: 6800, swapUsedMB: 0 }, top: [], model: null };

describe("what is slowing things down", () => {
  it("says nothing when the computer has room to spare", () => {
    expect(judgeBottleneck(base, true)).toMatchObject({ kind: "waiting" }); // idle CPU while the model works: loading or waiting
    expect(judgeBottleneck(base, false)).toBeNull();
    expect(judgeBottleneck({ ...base, cpu: { percent: 50, cores: 4 } }, true)).toBeNull();
  });
  it("names memory first when it runs short or the disk is used as memory", () => {
    expect(judgeBottleneck({ ...base, memory: { ...base.memory, availableMB: 400 } }, true)?.kind).toBe("memory");
    const swapped = judgeBottleneck({ ...base, cpu: { percent: 95, cores: 4 }, memory: { ...base.memory, availableMB: 1900, swapUsedMB: 2200 } }, true);
    expect(swapped).toMatchObject({ kind: "memory" });
    expect(swapped?.text).toMatch(/2\.2 GB swapped to disk/);
    // Old pages on disk while 5.8 GB is free are not a bottleneck (seen live: it blamed memory wrongly).
    expect(judgeBottleneck({ ...base, cpu: { percent: 59, cores: 4 }, memory: { ...base.memory, availableMB: 5800, swapUsedMB: 1800 } }, true)).toBeNull();
  });
  it("blames another program only when it really uses the CPU", () => {
    const busy = { ...base, cpu: { percent: 97, cores: 4 } };
    expect(judgeBottleneck({ ...busy, top: [{ name: "claude-desktop", percent: 114 }, { name: "the local model", percent: 300 }] }, true)).toMatchObject({ kind: "cpu-other", text: expect.stringContaining("“claude-desktop” is using 114%") });
    expect(judgeBottleneck({ ...busy, top: [{ name: "the local model", percent: 380 }] }, true)).toMatchObject({ kind: "cpu-model", text: expect.stringContaining("normal on a laptop") });
    expect(judgeBottleneck({ ...busy, top: [{ name: "firefox", percent: 12 }] }, true)?.kind).toBe("cpu-model");
  });
  it("names processes in plain words", () => {
    expect(friendlyName("llama-server")).toBe("the local model");
    expect(friendlyName("next-server (v1")).toBe("this app");
    expect(friendlyName("claude-desktop")).toBe("claude-desktop");
    expect(friendlyName("MainThread", "node /home/u/app/node_modules/vitest/dist/workers/forks.js")).toBe("forks");
    expect(friendlyName("node", "node --require x /home/u/app/scripts/worker.mts")).toBe("worker");
    expect(friendlyName("npm", "npm exec vitest run")).toBe("vitest");
  });
  it("reads this computer without throwing, with plausible numbers", async () => {
    const r = await systemResources(false);
    expect(r.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(r.cpu.percent).toBeLessThanOrEqual(100);
    expect(r.memory.totalMB).toBeGreaterThan(500);
    expect(r.memory.usedMB).toBeLessThanOrEqual(r.memory.totalMB);
    expect(r.model).toBeNull(); // nothing listens on the test Ollama address
  });
});
