import { describe, expect, it } from "vitest";
import { checkRequest, errorResponse, HttpError, readJson, redactSecrets } from "@/server/http";
import { UserError } from "@/server/errors";

const req = (headers: Record<string, string>, body?: string, method = "POST") => new Request("http://127.0.0.1:3000/api/x", { method, headers, body });

describe("request guard", () => {
  const ok = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", "x-acc-request": "1" };

  it("accepts a same-origin JSON request with the custom header", () => {
    expect(() => checkRequest(req(ok), true)).not.toThrow();
  });

  it.each([
    [{ ...ok, host: "evil.example" }, "DNS-rebinding host"],
    [{ ...ok, origin: "https://evil.example" }, "cross-site origin"],
    [{ ...ok, origin: "null" }, "opaque origin"],
    [{ ...ok, origin: "::garbage::" }, "malformed origin"],
    [{ ...ok, "content-type": "text/plain" }, "form-style content type"],
    [{ ...ok, "x-acc-request": "" }, "missing custom header"],
  ])("refuses %#: %s", (headers) => {
    expect(() => checkRequest(req(headers as Record<string, string>), true)).toThrow(HttpError);
  });

  it("caps the body while streaming, even without content-length", async () => {
    const big = "x".repeat(400_000);
    await expect(readJson(req({ "content-type": "application/json" }, JSON.stringify({ big })))).rejects.toThrow(/too large/);
    expect(await readJson(req({ "content-type": "application/json" }, '{"a":1}'))).toEqual({ a: 1 });
  });

  it("redacts secrets from log messages", () => {
    const msg = redactSecrets('connect to mongodb+srv://user:pw@cluster.example/db failed; Authorization: Bearer ya29.abc; {"refresh_token":"1//xyz"} api_key=sk-123');
    expect(msg).not.toMatch(/pw@|ya29|1\/\/xyz|sk-123/);
  });
});

describe("error responses", () => {
  it("shows a user-facing error as written, with its status; hides anything unexpected", async () => {
    const shown = errorResponse(new UserError("Couldn't remove shared notes from Atlas, so nothing was changed: timeout", 502));
    expect(shown.status).toBe(502);
    expect(await shown.json()).toEqual({ error: "Couldn't remove shared notes from Atlas, so nothing was changed: timeout" });
    const hidden = errorResponse(new Error("ECONNREFUSED 10.0.0.5:27017 mongodb+srv://u:p@host"));
    expect(hidden.status).toBe(500);
    expect((await hidden.json()).error).toBe("Something went wrong. Check the server log.");
  });
});
