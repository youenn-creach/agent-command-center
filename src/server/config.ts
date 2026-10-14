import { z } from "zod";

/**
 * Configuration is read from the environment once, validated, and never sent to the browser.
 * Only `publicConfig()` (booleans and model names — no secrets) is exposed to the UI.
 */

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const localUrl = z
  .url()
  .refine((u) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname), {
    message: "must point at a local host — the local LLM must not silently become a hosted service",
  });

const EnvSchema = z
  .object({
    ACC_TIMEZONE: z.string().optional(),
    /** personal = your accounts only (demo services hidden); demo = fictional data only (real accounts blocked); mixed = both. */
    ACC_MODE: z.enum(["personal", "demo", "mixed"]).default("mixed"),
    /** Link to the other instance (e.g. the demo on :3001), shown in the header. Local only. */
    ACC_PEER_URL: z
      .string()
      .url()
      .refine((u) => ["http:", "https:"].includes(new URL(u).protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname), { message: "must be a local http(s) URL" })
      .optional(),
    OLLAMA_URL: localUrl.default("http://127.0.0.1:11434"),
    OLLAMA_CHAT_MODEL: z.string().min(1).default("ministral-3:3b"),
    OLLAMA_EMBED_MODEL: z.string().min(1).default("nomic-embed-text"),
    ATLAS_ENABLED: bool,
    MONGODB_URI: z.string().optional(),
    ATLAS_DB_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,38}$/).default("agent_command_center"),
    VOYAGE_ENABLED: bool,
    VOYAGE_API_KEY: z.string().optional(),
    VOYAGE_EMBED_MODEL: z.string().min(1).default("voyage-4-lite"),
    VOYAGE_RERANK_MODEL: z.string().default("rerank-3-lite"),
    VOYAGE_DIMENSIONS: z.coerce.number().int().refine((n) => [256, 512, 1024, 2048].includes(n)).default(512),
    // Voyage applies 3 requests/min to accounts without a payment method. Raise only if your account allows it.
    VOYAGE_MAX_RPM: z.coerce.number().int().min(1).max(2000).default(3),
    MCP_TOKEN: z.string().optional(),
    // Optional Google connectors (read-only). Leave unset to keep Gmail / Google Calendar disabled.
    GOOGLE_CLIENT_ID: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, "must look like ….apps.googleusercontent.com").optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z
      .url()
      .refine((u) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname) && new URL(u).protocol === "http:", { message: "must be a loopback http:// URL" })
      .default("http://127.0.0.1:3000/api/oauth/google/callback"),
  })
  .superRefine((env, ctx) => {
    if (env.ATLAS_ENABLED && !env.MONGODB_URI?.match(/^mongodb(\+srv)?:\/\//)) {
      ctx.addIssue({ code: "custom", path: ["MONGODB_URI"], message: "ATLAS_ENABLED=true requires a mongodb:// or mongodb+srv:// URI" });
    }
    if (env.VOYAGE_ENABLED && !env.VOYAGE_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["VOYAGE_API_KEY"], message: "VOYAGE_ENABLED=true requires VOYAGE_API_KEY" });
    }
    if (env.MCP_TOKEN !== undefined && env.MCP_TOKEN.length > 0 && env.MCP_TOKEN.length < 24) {
      ctx.addIssue({ code: "custom", path: ["MCP_TOKEN"], message: "MCP_TOKEN must be at least 24 characters" });
    }
  });

export type Config = z.infer<typeof EnvSchema> & { timezone: string };

let cached: Config | undefined;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // An empty value (e.g. `GOOGLE_CLIENT_ID=` left blank in .env.local) means "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Name the variable, never echo its value.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration — ${problems}`);
  }
  const timezone = parsed.data.ACC_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return { ...parsed.data, timezone };
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Re-reads the environment (tests switch ACC_MODE). */
export function reloadConfig() {
  cached = undefined;
}

export function publicConfig() {
  const c = config();
  return {
    timezone: c.timezone,
    mode: c.ACC_MODE,
    peerUrl: c.ACC_PEER_URL ?? null,
    ollama: { chatModel: c.OLLAMA_CHAT_MODEL, embedModel: c.OLLAMA_EMBED_MODEL },
    atlas: { configured: c.ATLAS_ENABLED, dbName: c.ATLAS_DB_NAME },
    voyage: { configured: c.VOYAGE_ENABLED, embedModel: c.VOYAGE_EMBED_MODEL, rerankModel: c.VOYAGE_RERANK_MODEL, dimensions: c.VOYAGE_DIMENSIONS, maxRpm: c.VOYAGE_MAX_RPM },
    mcp: { tokenConfigured: Boolean(c.MCP_TOKEN) },
    google: { configured: Boolean(c.GOOGLE_CLIENT_ID), redirectUri: c.GOOGLE_REDIRECT_URI },
  };
}
