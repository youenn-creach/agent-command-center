import { test, expect } from "@playwright/test";

/**
 * Autopilot in a real browser (docs/AUTOPILOT_SECURITY_TESTS.md, e2e): turning a kind on in Settings shows the header switch;
 * pausing returns everything to "Ask first"; something done without a click is listed under "Done for you" and Undo removes it.
 */
test("autopilot: switch on in Settings, pause from the header, Undo from Done for you", async ({ page }) => {
  await page.goto(`/?e2e=${Date.now()}#settings`);
  await expect(page.locator("main h2").first()).toBeVisible();
  // Off by default: no header switch.
  await expect(page.getByRole("button", { name: /Autopilot (on|paused)/ })).toHaveCount(0);
  // The box follows the saved setting (it changes once the server has it): click, then wait for the header switch.
  await page.getByLabel(/Calendar events you ask for/).click();
  const header = page.getByRole("button", { name: "Autopilot on · Pause" });
  await expect(header).toBeVisible();
  // The kill switch: one click, everything asks first.
  await header.click();
  await expect(page.getByRole("button", { name: "Autopilot paused · Resume" })).toBeVisible();
  await expect(page.getByText("Paused: everything asks first.")).toBeVisible();
  await page.getByRole("button", { name: "Autopilot paused · Resume" }).click();
  await expect(page.getByRole("button", { name: "Autopilot on · Pause" })).toBeVisible();

  // A reminder from the prompt bar is listed under Done for you; Undo removes it.
  await page.goto(`/?e2e=${Date.now()}#today`);
  await page.getByLabel("Ask your Chief of Staff").fill("remind me to water the plants tomorrow at 6pm");
  await page.getByLabel("Ask your Chief of Staff").press("Enter");
  await expect(page.getByRole("dialog", { name: "Chief of Staff reply" })).toContainText("Water the plants");
  await page.getByRole("button", { name: "Close" }).click();
  const card = page.locator("section").filter({ hasText: "Done for you" });
  await expect(card).toContainText("Water the plants");
  await card.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Done for you", { exact: true })).toHaveCount(0);

  // Back to the default for the other tests.
  await page.goto(`/?e2e=${Date.now()}#settings`);
  await page.getByLabel(/Calendar events you ask for/).click();
  await expect(page.getByRole("button", { name: /Autopilot (on|paused)/ })).toHaveCount(0);
});
