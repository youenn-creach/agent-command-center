import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A 30–40 s screen recording of the fictional demo for the launch post (never your real data):
 * Impact card → nudge someone who hasn't answered → approve the exact draft → Ctrl+K event in
 * French → Atlas + Voyage vs keyword search → the Impact card again.
 *   npm run build:e2e && RECORDING=1 SCREENSHOTS_LIVE=1 npx playwright test e2e/recording.spec.ts
 * Writes launch/demo-recording.webm (git-ignored). Without SCREENSHOTS_LIVE the search part uses
 * the local voyage-4-nano model if installed.
 */
test.skip(!process.env.RECORDING, "set RECORDING=1 to record the demo video");
test.use({ viewport: { width: 1280, height: 720 }, colorScheme: "light" });

const live = process.env.SCREENSHOTS_LIVE === "1";
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Recordings have no pointer: draw one, with a ripple on each click, so viewers can follow. */
const CURSOR = `
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(63,91,216,.35);border:2px solid #3f5bd8;pointer-events:none;left:-40px;top:-40px;transition:transform .12s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.7)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; }, true);
  });
`;

/** Glide to the element, then click: real mouse events, so the drawn cursor moves and ripples. */
async function click(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("element not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await pause(page, 180);
  await page.mouse.down();
  await page.mouse.up();
}

async function nav(page: Page, label: string) {
  await click(page, page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: label }));
  await expect(page.locator("main h2").first()).toBeVisible();
}

test("record the demo", async ({ browser, request, baseURL }) => {
  test.setTimeout(300_000);
  const api = (body: object, path: string) => request.post(path, { data: body, headers: { "x-acc-request": "1", origin: "http://127.0.0.1:3100" } });

  // Set-up, before anything worth watching: approvals allowed on Demo Gmail, Atlas live and synced.
  expect((await api({ op: "service", serviceId: "demo-mail", level: "write_with_approval" }, "/api/permissions")).ok()).toBe(true);
  if (live) {
    expect((await api({ op: "consent", value: true }, "/api/showcase")).ok()).toBe(true);
    expect((await api({ op: "sync-atlas" }, "/api/knowledge")).ok()).toBe(true);
  } else {
    await api({ op: "index-local" }, "/api/knowledge");
  }

  // Recording starts only now, so the video opens on the dashboard rather than a blank page.
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, colorScheme: "light", recordVideo: { dir: "test-results/recording", size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const started = Date.now();
  await page.addInitScript(CURSOR);
  await page.goto("/#today");
  await expect(page.getByText("Impact this week")).toBeVisible();
  await page.mouse.move(640, 360);
  await pause(page, 2800);

  // 1. Someone hasn't answered: draft a polite nudge in the same thread.
  await nav(page, "Inbox insights");
  await pause(page, 1500);
  await click(page, page.getByRole("listitem").filter({ hasText: "Quote for the kitchen shelves" }).getByRole("button", { name: "Draft a nudge" }));
  await expect(page.getByText(/Follow-up drafted/)).toBeVisible();
  await pause(page, 1400);

  // 2. Nothing goes out until you approve the exact content.
  await nav(page, "Action Queue");
  const card = page.locator("main section").filter({ hasText: /Follow-up to Priya/ }).first();
  await click(page, card.getByRole("button", { name: "Review & approve" }));
  await pause(page, 2600);
  await click(page, card.getByRole("button", { name: "Approve this exact action" }));
  await expect(page.getByText(/Approved\. Execute it when ready/).first()).toBeVisible();
  await pause(page, 900);
  await click(page, card.getByRole("button", { name: "Execute (simulated)" }));
  await expect(page.getByText(/Simulated send/).first()).toBeVisible();
  await pause(page, 1600);

  // 3. Ctrl+K, in French: a note becomes a calendar event card.
  await click(page, page.getByLabel("Ask your Chief of Staff"));
  await page.keyboard.type("rdv : dîner chez Julien vendredi 20h", { delay: 55 });
  await pause(page, 400);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Add to Google Calendar" })).toBeVisible();
  await pause(page, 3000);
  await page.keyboard.press("Escape");
  await page.getByLabel("Ask your Chief of Staff").fill("");

  // 4. Search by meaning: keyword search finds nothing, Atlas Vector Search with Voyage AI finds the note.
  await nav(page, "Under the hood");
  await click(page, page.getByRole("radio", { name: live ? /Atlas Vector Search \+ Voyage AI/ : /voyage-4-nano/ }));
  await page.getByLabel("Compare with").selectOption("lexical");
  const question = page.getByRole("textbox", { name: "Question" });
  await click(page, question);
  await question.fill("");
  await page.keyboard.type("When is my bicycle getting repaired?", { delay: 45 });
  await click(page, page.getByRole("button", { name: "Search", exact: true }));
  await expect(page.locator("ol[aria-label='Pipeline trace']").first()).toBeVisible({ timeout: 90_000 });
  await question.evaluate((el) => window.scrollBy({ top: el.getBoundingClientRect().top - 80, behavior: "smooth" }));
  await pause(page, 4200);

  // 5. Back to Today: the Impact card counted the nudge.
  await nav(page, "Today");
  await expect(page.getByText("Impact this week")).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await pause(page, 3200);

  const seconds = Math.ceil((Date.now() - started) / 1000) + 1;
  const video = page.video();
  await context.close();
  if (video) {
    mkdirSync("launch", { recursive: true });
    // The recorder keeps writing frames while the context closes: keep only the part that happened.
    const cache = path.join(os.homedir(), ".cache", "ms-playwright");
    const ffmpeg = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("ffmpeg-")).sort().map((d) => path.join(cache, d, "ffmpeg-linux")).filter(existsSync).at(-1) : undefined;
    if (ffmpeg) execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", await video.path(), "-t", String(seconds), "-c", "copy", "launch/demo-recording.webm"]);
    else copyFileSync(await video.path(), "launch/demo-recording.webm");
  }
});
