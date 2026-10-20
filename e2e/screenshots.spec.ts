import { test, expect, type Page } from "@playwright/test";

/**
 * README and launch screenshots of the fictional demo, from the isolated instance (never your real data).
 *   npm run build:e2e && SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 * Add SCREENSHOTS_LIVE=1 to show Atlas + Voyage on the fictional corpus (uses the Atlas/Voyage settings
 * in .env.local; a handful of Voyage requests, within the free tier). Without it, semantic search
 * uses the local voyage-4-nano model if installed. The search-quality chart shows the last
 * `npm run eval` results (data/eval-latest.json), imported into the throwaway instance.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture README screenshots");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

const out = (name: string) => `docs/screenshots/${name}.png`;
const live = process.env.SCREENSHOTS_LIVE === "1";

async function go(page: Page, section: string, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/?shot=${Date.now()}#${section}`);
  await expect(page.locator("main h2").first()).toBeVisible();
  await page.waitForTimeout(300);
}

/** Notifications fade after a few seconds; screenshots shouldn't carry them. */
const settle = (page: Page) => page.waitForTimeout(6500);

async function approveAndExecute(page: Page, title: RegExp) {
  await go(page, "actions", "light");
  const card = page.locator("main section").filter({ hasText: title }).first();
  await card.getByRole("button", { name: "Review & approve" }).click();
  await card.getByRole("button", { name: "Approve this exact action" }).click();
  await expect(page.getByText(/Approved\. Execute it when ready/).first()).toBeVisible();
  await card.getByRole("button", { name: "Execute (simulated)" }).click();
  await expect(page.getByText(/Simulated send/).first()).toBeVisible();
}

test("capture", async ({ page }) => {
  test.setTimeout(900_000);

  // Live mode first, so every screenshot shows the services as they'll be used.
  if (live) {
    await go(page, "tech", "light");
    const consent = page.getByRole("checkbox", { name: /I confirm my Atlas cluster/ });
    // The box reflects the server's state, so it ticks once the change is saved.
    if (!(await consent.isChecked())) await consent.click();
    await expect(consent).toBeChecked();
    await page.getByRole("button", { name: /Sync demo corpus to Atlas/ }).click();
    await expect(page.getByText(/Embedded \d+ demo chunks/)).toBeVisible({ timeout: 120_000 });
  }

  // A realistic week in the demo: drafts and a briefing, one reply and one nudge approved, a booking reminder.
  await go(page, "schedules", "light");
  // One local model at a time: drafts first, then the briefing (which would time out waiting behind them).
  // Waits read the dashboard state rather than notifications that fade.
  const state = async () => (await page.request.get("/api/state")).json();
  await page.locator("section", { hasText: "Friday follow-up sweep" }).first().getByRole("button", { name: "Run now" }).click();
  await expect.poll(async () => (await state()).actions.filter((a: { title: string }) => a.title.startsWith("Reply to ")).length, { timeout: 600_000, intervals: [3000] }).toBeGreaterThanOrEqual(3);
  await go(page, "schedules", "light");
  await page.locator("section", { hasText: "Morning tech briefing" }).first().getByRole("button", { name: "Run now" }).click();
  await expect.poll(async () => Boolean((await state()).today?.briefing), { timeout: 600_000, intervals: [3000] }).toBe(true);
  await go(page, "schedules", "light");
  await settle(page);
  await page.screenshot({ path: out("schedules-light") });

  await go(page, "permissions", "light");
  await page.getByLabel("Access level for Demo Gmail").selectOption("write_with_approval");
  await expect(page.getByText("Demo Gmail: Write with approval")).toBeVisible();
  await approveAndExecute(page, /Reply to maria\.lopez@example\.com/);

  await go(page, "insights", "light");
  await page.getByRole("listitem").filter({ hasText: "Quote for the kitchen shelves" }).getByRole("button", { name: "Draft a nudge" }).click();
  await expect(page.getByText(/Follow-up drafted/)).toBeVisible();
  await page.getByRole("listitem").filter({ hasText: "Your e-ticket: Lisbon" }).getByRole("button", { name: "Remind me" }).click();
  await expect(page.getByText(/Added to your reminders/)).toBeVisible();
  await approveAndExecute(page, /Follow-up to Priya/);

  await go(page, "insights", "light");
  await page.screenshot({ path: out("insights-light") });

  // The approval screen, with different kinds of drafts on top (the sweep's holding replies all read the same):
  // a nudge to Tom, then a reply to Jordan written from your own words, opened for approval.
  await go(page, "actions", "light");
  await page.locator("main section").filter({ hasText: /Reply to jordan@example\.com/ }).first().getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Dismissed").first()).toBeVisible();
  await go(page, "insights", "light");
  await page.getByRole("listitem").filter({ hasText: "Photos from the trip?" }).getByRole("button", { name: "Draft a nudge" }).click();
  await expect(page.getByText(/Follow-up drafted/)).toBeVisible();
  await go(page, "today", "light");
  await page.keyboard.press("Control+k");
  await page.getByLabel("Ask your Chief of Staff").fill("reply to jordan that I vote for the first book and can bring the snacks");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  await expect.poll(async () => (await state()).actions.some((a: { title: string; status: string }) => a.status === "proposed" && /Reply to jordan/.test(a.title)), { timeout: 600_000, intervals: [3000] }).toBe(true);
  await page.keyboard.press("Escape");
  await go(page, "actions", "light");
  const card = page.locator("main section").filter({ hasText: /Reply to jordan@example\.com/ }).first();
  await card.getByRole("button", { name: "Review & approve" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("approval-light") });

  await go(page, "today", "light");
  await expect(page.getByText("Impact this week")).toBeVisible();
  await page.screenshot({ path: out("today-light") });
  await go(page, "today", "dark");
  await page.screenshot({ path: out("today-dark") });

  // Ctrl+K: a French note becomes a calendar event card, added only when you click.
  await go(page, "today", "light");
  await page.keyboard.press("Control+k");
  await page.getByLabel("Ask your Chief of Staff").fill("rdv : dîner chez Julien vendredi 20h");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  await expect(page.getByRole("link", { name: "Add to Google Calendar" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("command-event-light") });
  await page.keyboard.press("Escape");

  await go(page, "permissions", "dark");
  await page.screenshot({ path: out("permissions-dark") });

  // Keyword search vs semantic search on the same question, with the step-by-step trace.
  await go(page, "tech", "dark");
  let semantic: RegExp | null = null;
  if (live) {
    semantic = /Atlas Vector Search \+ Voyage AI/;
  } else {
    const index = page.getByRole("button", { name: "Index locally" });
    if (await index.isEnabled()) {
      await index.click();
      await expect(page.getByText(/Indexed \d+ new chunks locally/)).toBeVisible({ timeout: 120_000 });
      semantic = /voyage-4-nano/;
    }
  }
  if (semantic) {
    await page.getByRole("radio", { name: semantic }).click();
    await page.getByLabel("Compare with").selectOption("lexical");
  }
  await page.getByRole("textbox", { name: "Question" }).fill("When is my bicycle getting repaired?");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("ol[aria-label='Pipeline trace']").first()).toBeVisible({ timeout: 90_000 });
  await settle(page);
  // The question stays in frame, with both result columns under it.
  await page.getByRole("textbox", { name: "Question" }).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 90));
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("showcase-dark") });

  // Search quality: measured recall@1 per provider.
  const chart = page.getByRole("figure", { name: /recall@1/ });
  if (await chart.count()) {
    await chart.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 140));
    await page.waitForTimeout(300);
    await page.locator("section").filter({ has: chart }).screenshot({ path: out("search-quality-dark") });
  }
});
