import { describe, expect, it } from "vitest";
import { danger, parseMeminfo, parsePressure } from "../scripts/memory-guard.mjs";

const meminfo = (availMb: number, swapFreeMb: number) =>
  `MemTotal:       12130728 kB\nMemFree:          200000 kB\nMemAvailable:   ${availMb * 1024} kB\nSwapTotal:       2097148 kB\nSwapFree:       ${swapFreeMb * 1024} kB\n`;
const limits = { minAvailableMb: 400, lowAvailableMb: 800, minSwapFreePct: 15, maxFullStallPct: 15 };

describe("the memory guard", () => {
  it("reads memory and pressure from the kernel's text", () => {
    expect(parseMeminfo(meminfo(1320, 712))).toMatchObject({ availableMb: 1320, swapFreeMb: 712 });
    expect(Math.round(parseMeminfo(meminfo(1, 1)).swapTotalMb)).toBe(2048);
    expect(parsePressure("some avg10=0.56 avg60=2.64 avg300=1.29 total=5518145\nfull avg10=17.13 avg60=1.41 avg300=0.80 total=3551854\n")).toBe(17.13);
    expect(parsePressure(undefined)).toBe(0);
  });

  it("stays quiet in normal use: the 8B loaded, swap partly used (what the machine looks like during an evaluation)", () => {
    expect(danger(parseMeminfo(meminfo(1320, 712)), 0.13, limits)).toBeNull();
    expect(danger(parseMeminfo(meminfo(700, 900)), 2, limits)).toBeNull(); // low memory but swap still has room
  });

  it("acts before a freeze: almost no memory, low memory with swap nearly full, or the system stalling", () => {
    expect(danger(parseMeminfo(meminfo(350, 1500)), 0, limits)).toMatch(/350 MB of memory free.*under 400 MB/);
    expect(danger(parseMeminfo(meminfo(700, 200)), 0, limits)).toMatch(/swap 90% full.*nearly full/);
    expect(danger(parseMeminfo(meminfo(1200, 900)), 22, limits)).toMatch(/stalled on memory 22%/);
  });
});
