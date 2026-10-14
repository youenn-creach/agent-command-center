import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    sequence: { hooks: "list" },
    env: {
      ACC_TIMEZONE: "Europe/Paris",
      // Nothing listens there: unit tests never call a real local model (they pass stubs where they need one).
      OLLAMA_URL: "http://127.0.0.1:9",
      ATLAS_ENABLED: "false",
      VOYAGE_ENABLED: "false",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      // Throwaway token key for tests — never the real one in ~/.config.
      ACC_KEY_FILE: path.join(os.tmpdir(), `acc-test-${process.pid}`, "token.key"),
    },
    testTimeout: 15_000,
  },
});
