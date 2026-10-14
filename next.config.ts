import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy without nonces (nonces would force dynamic rendering, which the
 * bundled Next.js docs mark as incompatible with Partial Prerendering). Inline scripts are
 * allowed because Next.js inlines its bootstrap; everything else is locked to this origin:
 * no external scripts, no exfiltration via fetch/img to other hosts, no plugins, no framing.
 * Untrusted text is rendered by React (escaped), never as raw HTML. See docs/SECURITY.md.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Test and screenshot builds go to their own folder, so they never touch the build the live app serves.
  distDir: process.env.ACC_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  // Server-only packages loaded with native require (no bundling).
  serverExternalPackages: ["mongodb", "@huggingface/transformers"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
