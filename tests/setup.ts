import { afterEach } from "vitest";

// A test's background requests (Ctrl+K answers) finish before its fakes are removed, so they never reach
// the real network. Runs before each file's own afterEach hooks (sequence.hooks = "list"). The queue is
// read from globalThis (see runInBackground) so this file loads no app code before a test's own mocks.
afterEach(async () => {
  await (globalThis as { __accBackground?: { tail: Promise<void> } }).__accBackground?.tail;
});
