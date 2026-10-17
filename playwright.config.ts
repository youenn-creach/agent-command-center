import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * End-to-end tests run against a separate instance of the production build:
 * port 3100, a throwaway data directory, and every cloud/LLM integration forced off,
 * so they never touch your real data, Atlas, Voyage or Google (screenshots may opt in to Atlas +
 * Voyage on the fictional corpus with SCREENSHOTS_LIVE=1; see e2e/screenshots.spec.ts).
 *
 * Browser: an installed Chromium-based browser (PLAYWRIGHT_BROWSER_PATH, else Brave/Chrome/Chromium
 * at the usual Linux paths). Falls back to Playwright's own Chromium if none is found
 * (`npx playwright install chromium` downloads it).
 */

const candidates = [process.env.PLAYWRIGHT_BROWSER_PATH, "/opt/brave.com/brave/brave", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean) as string[];
const executablePath = candidates.find((p) => existsSync(p));
// Its own subfolder: the test server wipes it, and .e2e-data also holds evaluation runs that must survive.
const dataDir = path.join(process.cwd(), ".e2e-data", "playwright");
// Screenshots can show the measured search quality (imported from the last `npm run eval`) and,
// with SCREENSHOTS_LIVE=1, Atlas + Voyage on the fictional corpus. Tests never do either.
const shots = Boolean(process.env.SCREENSHOTS || process.env.RECORDING);
const live = shots && process.env.SCREENSHOTS_LIVE === "1";
const importEval = shots && existsSync("data/eval-latest.json") ? `ACC_DATA_DIR="${dataDir}" npx tsx scripts/load-eval.mts data/eval-latest.json && ` : "";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    launchOptions: executablePath ? { executablePath } : {},
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `rm -rf "${dataDir}" && mkdir -p "${dataDir}" && ${importEval}npx next start -H 127.0.0.1 -p 3100`,
    url: "http://127.0.0.1:3100/api/state",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ACC_DIST_DIR: ".next-e2e", // build first: npm run build:e2e
      ACC_DATA_DIR: dataDir,
      ...(live ? {} : { ATLAS_ENABLED: "false", VOYAGE_ENABLED: "false" }),
      ACC_MODE: "demo", // fictional data only; real connectors refused
      GOOGLE_CLIENT_ID: "",
      // Nothing listens there: LLM features fall back, by design. Live screenshots use your local Ollama.
      ...(live ? {} : { OLLAMA_URL: "http://127.0.0.1:9" }),
      // Screenshots use the local voyage-4-nano model (if installed) to show semantic search; tests don't.
      ACC_MODEL_DIR: process.env.SCREENSHOTS ? path.join(process.cwd(), "models") : path.join(dataDir, "no-models"),
      ACC_TIMEZONE: "Europe/Paris",
    },
  },
});
