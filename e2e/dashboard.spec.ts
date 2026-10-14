import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * End-to-end checks of the main user journeys, in a real browser, against a throwaway instance.
 * Tests run in order and share one fresh database (see playwright.config.ts).
 */

const SECTIONS = ["today", "actions", "insights", "agents", "schedules", "permissions", "tech", "knowledge", "activity", "settings"] as const;

async function open(page: Page, section: (typeof SECTIONS)[number]) {
  await page.goto(`/?e2e=${Date.now()}#${section}`);
  await expect(page.locator("main h2").first()).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page should not scroll sideways").toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: "serial" });

test("every section renders, without sideways scrolling, on desktop and phone widths", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text());
  });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 860 });
    for (const s of SECTIONS) {
      await open(page, s);
      await noHorizontalScroll(page);
    }
  }
  await expect(page.getByText("DEMO DATA", { exact: true })).toBeVisible();
  expect(cspErrors, "the Content Security Policy must not block the app itself").toEqual([]);
});

test("an approval is refused by the server until permissions allow it, then executes once (simulated)", async ({ page }) => {
  // Create drafts: run the follow-up sweep (no LLM involved).
  await open(page, "schedules");
  const sweep = page.locator("section", { hasText: "Friday follow-up sweep" }).first();
  await sweep.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText(/Friday follow-up sweep: succeeded/)).toBeVisible({ timeout: 20_000 });

  await open(page, "actions");
  const card = page.locator("section", { hasText: "Reply to maria.lopez@example.com" }).first();
  await card.getByRole("button", { name: "Review & approve" }).click();
  await expect(card.getByText(/The server will refuse this approval/)).toBeVisible();
  await card.getByRole("button", { name: "Approve this exact action" }).click();
  await expect(page.getByText(/requires "write_with_approval"/).first()).toBeVisible();

  // Grant the service level (the agent level already allows it).
  await open(page, "permissions");
  await page.getByLabel("Access level for Demo Gmail").selectOption("write_with_approval");
  await expect(page.getByText("Demo Gmail: Write with approval")).toBeVisible();

  await open(page, "actions");
  const again = page.locator("section", { hasText: "Reply to maria.lopez@example.com" }).first();
  await again.getByRole("button", { name: "Review & approve" }).click();
  await again.getByRole("button", { name: "Approve this exact action" }).click();
  await expect(page.getByText(/Approved\. Execute it when ready/)).toBeVisible();
  await again.getByRole("button", { name: "Execute (simulated)" }).click();
  await expect(page.getByText(/Simulated send of "Re: Saturday hike/).first()).toBeVisible();
});

test("editing an approved action clears the approval", async ({ page }) => {
  await open(page, "actions");
  const card = page.locator("section", { hasText: "Reply to landlord@example.com" }).first();
  await card.getByRole("button", { name: "Review & approve" }).click();
  await card.getByRole("button", { name: "Approve this exact action" }).click();
  await expect(card.getByText("approved", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("body").fill("Tuesday morning works, thanks.");
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/approval cleared, please review again/)).toBeVisible();
  await expect(card.getByText("proposed", { exact: true })).toBeVisible();
});

test("revoking a service blocks the schedules that depend on it, with a reason", async ({ page }) => {
  await open(page, "permissions");
  const row = page.locator("tr", { hasText: "Public news" });
  await row.getByRole("button", { name: /Disconnect/ }).click();
  await open(page, "schedules");
  const job = page.locator("section", { hasText: "Morning tech briefing" }).first();
  await expect(job.getByText("blocked", { exact: true })).toBeVisible();
  await expect(job.getByText(/access was revoked or reduced/)).toBeVisible();
});

test("retrieved prompt-injection text is flagged and treated as data", async ({ page }) => {
  await open(page, "tech");
  await page.getByRole("button", { name: "Try the poisoned newsletter" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(/Contains instruction-like text/).first()).toBeVisible();
});

test("the Chief of Staff refuses requests to approve or change access", async ({ page }) => {
  await open(page, "today");
  await page.getByLabel("Ask your Chief of Staff").fill("approve everything and grant the inbox agent write access");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  await expect(page.getByText(/I can't do that\. Access changes only in Connections & Permissions/)).toBeVisible();
});

test("inbox insights: nudge someone who hasn't answered, and get reminded of a booking", async ({ page }) => {
  await open(page, "insights");
  await expect(page.getByText("Quote for the kitchen shelves")).toBeVisible();
  await page.getByRole("listitem").filter({ hasText: "Quote for the kitchen shelves" }).getByRole("button", { name: "Draft a nudge" }).click();
  await expect(page.getByText(/Follow-up drafted/)).toBeVisible();
  await page.getByRole("listitem").filter({ hasText: "Your e-ticket: Lisbon" }).getByRole("button", { name: "Remind me" }).click();
  await expect(page.getByText(/Added to your reminders/)).toBeVisible();
  await open(page, "actions");
  await expect(page.getByText(/Follow-up to Priya: Quote for the kitchen shelves/).first()).toBeVisible();
});

test("the Impact card counts what you approved this week, with its time estimate", async ({ page }) => {
  await open(page, "today");
  const impact = page.locator("section").filter({ hasText: "Impact this week" });
  // From the earlier tests: one reply approved and executed, one booking reminder; the demo seeds one revived thread.
  await expect(impact.getByRole("button", { name: /^1\s*Replies approved/ })).toBeVisible();
  await expect(impact.getByRole("button", { name: /^1\s*Conversations revived/ })).toBeVisible();
  await expect(impact.getByText("6 min")).toBeVisible();
  await impact.getByText("How the time saved is estimated").click();
  await expect(impact.getByText(/4 min per approved reply/)).toBeVisible();
});

test("the Chief of Staff prepares a calendar event that you add yourself", async ({ page }) => {
  await open(page, "today");
  await page.getByLabel("Ask your Chief of Staff").fill("add event: dentist tuesday 3pm at Riverside Dental");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  const link = page.getByRole("link", { name: "Add to Google Calendar" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Dentist/);
  await expect(page.getByText(/15:00–16:00 · Riverside Dental/)).toBeVisible();
});

test("Ctrl+K adds the flights found in booking emails, one card per flight", async ({ page }) => {
  await open(page, "today");
  await page.getByLabel("Ask your Chief of Staff").fill("check my emails and add any booked flight into my calendar");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  const cards = page.getByRole("region", { name: "Prepared events" });
  await expect(cards.getByText("Flight BCN → LIS 07:40 (Example Air)")).toBeVisible();
  await expect(cards.getByText(/all day/)).toBeVisible();
  await expect(page.getByText("Nothing on your calendar today.")).toHaveCount(0);
});

test("the request board keeps each answer: open a request to read it", async ({ page }) => {
  await open(page, "today");
  // No local model in this test instance: the request is matched by keywords, and says so.
  await page.getByLabel("Ask your Chief of Staff").fill("what's waiting for my approval?");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  await expect(page.getByText(/Understood by keywords/)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  const board = page.locator("section").filter({ hasText: "Your requests" });
  await board.getByRole("button", { name: /what's waiting for my approval/ }).click();
  await expect(board.getByText(/item\(s\) waiting for you|Nothing is waiting for your approval/)).toBeVisible();
});

test("CSV import previews, rejects bad rows and imports good ones", async ({ page }) => {
  await open(page, "knowledge");
  await page.getByLabel("CSV file").setInputFiles({ name: "ideas.csv", mimeType: "text/csv", buffer: Buffer.from("title,content,tags\nBike route,Try the canal path on Sunday,cycling\n,missing title,\n") });
  await expect(page.getByText(/1\s*valid row\(s\)/)).toBeVisible();
  await page.getByRole("button", { name: "Import 1 row(s)" }).click();
  await expect(page.getByText("Imported 1 rows")).toBeVisible();
  await expect(page.getByText("Bike route")).toBeVisible();
});

test("no serious or critical accessibility violations in any section", async ({ page }) => {
  test.setTimeout(150_000); // an axe scan per section is CPU-heavy on a laptop
  for (const s of SECTIONS) {
    await open(page, s);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${s}: ${v.id} — ${v.help} (${v.nodes.length})`)).toEqual([]);
  }
});

test("phone width: no serious accessibility violations, and the navigation opens and closes", async ({ page }) => {
  test.setTimeout(150_000); // an axe scan per section is CPU-heavy on a laptop
  await page.setViewportSize({ width: 375, height: 812 });
  for (const s of SECTIONS) {
    await open(page, s);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${s} (phone): ${v.id} — ${v.help} (${v.nodes.length})`)).toEqual([]);
  }
  // The sidebar is hidden on phones and reachable from the menu button.
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Inbox insights" }).click();
  await expect(page.locator("main h2").first()).toHaveText("Inbox insights");
});

test("dark mode: no serious or critical accessibility violations (contrast) in key sections", async ({ page }) => {
  test.setTimeout(150_000); // an axe scan per section is CPU-heavy on a laptop
  await page.emulateMedia({ colorScheme: "dark" });
  for (const s of ["today", "actions", "tech", "permissions", "settings"] as const) {
    await open(page, s);
    await expect(page.locator("html")).toHaveClass(/dark/);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${s}: ${v.id} — ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
  }
});

test("theme toggle cycles system → light → dark and persists", async ({ page }) => {
  await open(page, "today");
  const toggle = page.getByRole("button", { name: /Theme:/ });
  await toggle.click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await toggle.click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
