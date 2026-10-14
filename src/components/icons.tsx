"use client";

import type { ReactNode } from "react";
import { cx } from "./ui";
import { MODEL_LOGOS } from "./modelLogos";

/**
 * Service icons. Gmail and Google Calendar use their recognisable colours so a real connection is
 * obvious at a glance; their fictional demo stand-ins use the same shapes in flat slate blue with a
 * dashed outline, so they are never mistaken for a live Google account.
 */
export function ServiceIcon({ id, size = 18, className }: { id: string; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, className: cx("shrink-0", className) } as const;
  switch (id) {
    case "gmail":
    case "gmail-drafts":
      return (
        <svg {...common}>
          <path fill="#4285F4" d="M2 7.3V17.5A1.5 1.5 0 0 0 3.5 19H6v-8.8z" />
          <path fill="#34A853" d="M18 10.2V19h2.5a1.5 1.5 0 0 0 1.5-1.5V7.3z" />
          <path fill="#EA4335" d="M6 10.2 12 14.5l6-4.3V6.3l-6 4.3-6-4.3z" />
          <path fill="#FBBC04" d="M18 6.3v3.9l4-2.9V6a1.5 1.5 0 0 0-2.4-1.2z" />
          <path fill="#C5221F" d="M2 6v1.3l4 2.9V6.3L4.4 4.8A1.5 1.5 0 0 0 2 6z" />
        </svg>
      );
    case "google-calendar":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#4285F4" strokeWidth="1.6" />
          <path fill="#4285F4" d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v2H3z" />
          <path fill="#34A853" d="M3 17h4v4H6a3 3 0 0 1-3-3z" />
          <path fill="#FBBC04" d="M17 17h4v1a3 3 0 0 1-3 3h-1z" />
          <text x="12" y="17.2" textAnchor="middle" fontSize="8" fontWeight="700" fill="#1A73E8" fontFamily="system-ui, sans-serif">
            31
          </text>
        </svg>
      );
    case "atlas":
      return (
        <svg {...common}>
          <path fill="var(--mongo)" d="M12.3 2c-.4 1.7-1.3 2.7-2.4 3.9C8.5 7.5 7.2 9.4 7.2 12.3c0 3 1.9 5.3 4.4 6.1l.3 3.6h.7l.3-3.6c2.6-.8 4-3.2 4-6.1 0-3-1.4-5-2.8-6.6-1-1.1-1.6-2.1-1.8-3.7z" />
        </svg>
      );
    case "voyage":
      return (
        <svg {...common}>
          <path fill="none" stroke="var(--voyage)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M4 5l8 14 8-14" />
          <path fill="none" stroke="var(--voyage)" strokeWidth="1.6" strokeLinecap="round" opacity=".5" d="M8 5l4 7 4-7" />
        </svg>
      );
    // Demo stand-ins keep the Gmail / Calendar shapes so their role is obvious, but in one flat
    // slate blue (--demo) with a dashed outline, so they never pass for the real, multicolour ones.
    case "demo-mail":
      return (
        <svg {...common} fill="none" stroke="var(--demo)" strokeWidth="1.8" strokeLinejoin="round">
          <rect x="2.5" y="5" width="19" height="14" rx="2" strokeDasharray="3 1.6" />
          <path d="M5.5 17V9l6.5 4.6L18.5 9v8" />
        </svg>
      );
    case "demo-calendar":
      return (
        <svg {...common} fill="none" stroke="var(--demo)" strokeWidth="1.6">
          <rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 1.6" />
          <path fill="var(--demo)" stroke="none" d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v2H3z" />
          <text x="12" y="17.2" textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--demo)" stroke="none" fontFamily="system-ui, sans-serif">
            31
          </text>
        </svg>
      );
    case "demo-notes":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M14 3v5h5M9 12h7M9 16h7" />
        </svg>
      );
    case "weather":
      return (
        <svg {...common} fill="none" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="9" cy="9" r="3.2" stroke="#f59e0b" />
          <path d="M9 2.5v1.3M9 14.2v1.3M2.5 9h1.3M14.2 9h1.3M4.4 4.4l.9.9M12.7 12.7l.9.9M4.4 13.6l.9-.9M12.7 5.3l.9-.9" stroke="#f59e0b" />
          <path d="M10 20h8a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.4A2.8 2.8 0 0 0 10 20z" stroke="currentColor" fill="var(--panel)" />
        </svg>
      );
    case "public-news":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8" />
          <circle cx="6" cy="18" r="1.5" fill="currentColor" />
        </svg>
      );
    case "local-tasks":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" />
        </svg>
      );
    default:
      if (id.startsWith("hook-")) {
        return (
          <svg {...common} fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinejoin="round">
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
          </svg>
        );
      }
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

export type LightState = "active" | "idle" | "off" | "revoked";

const LIGHT: Record<LightState, { dot: string; label: string }> = {
  active: { dot: "bg-ok", label: "text-ok" },
  idle: { dot: "bg-warn", label: "text-warn" },
  off: { dot: "bg-muted/60", label: "text-muted" },
  revoked: { dot: "bg-danger", label: "text-danger" },
};

/** Status light: a coloured dot plus a text label (never colour alone). Active connections get a soft pulse. */
export function StatusLight({ state, label, compact }: { state: LightState; label: string; compact?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap", compact ? "text-[11px]" : "text-xs", LIGHT[state].label)}>
      <span className="relative inline-flex h-2 w-2" aria-hidden>
        {state === "active" && <span className={cx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-50", LIGHT[state].dot)} />}
        <span className={cx("relative inline-flex h-2 w-2 rounded-full", LIGHT[state].dot)} />
      </span>
      {label}
    </span>
  );
}

const LEVEL_SHORT: Record<string, string> = { none: "no access", read: "read", prepare: "prepare", write_with_approval: "write w/ approval" };

/** Derives the light for a service from its connection state and service-level access. */
export function serviceLight(s: { connection_state: string; access_level: string; kind: string }): { state: LightState; label: string } {
  if (s.connection_state === "revoked") return { state: "revoked", label: "Revoked" };
  if (s.connection_state !== "connected") return { state: "off", label: s.kind === "real" ? "Not connected" : "Disconnected" };
  if (s.access_level === "none") return { state: "idle", label: "Connected · no access" };
  return { state: "active", label: `Connected · ${LEVEL_SHORT[s.access_level] ?? s.access_level}` };
}

/** One row: icon, name and status light. Used in the sidebar and section headers. */
export function ServiceStatus({ service, compact }: { service: { id: string; name: string; connection_state: string; access_level: string; kind: string }; compact?: boolean }) {
  const light = serviceLight(service);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ServiceIcon id={service.id} size={compact ? 15 : 18} className={service.kind === "demo" ? "text-muted" : undefined} />
      <span className={cx("min-w-0 flex-1 truncate", compact ? "text-[11px] text-ink" : "text-sm")} title={service.name}>
        {compact ? service.name.replace(/\s*\(.*\)$/, "") : service.name}
      </span>
      <StatusLight state={light.state} label={compact ? light.label.replace("Connected · ", "") : light.label} compact={compact} />
    </span>
  );
}

/** Sidebar section icons: one line-icon family (24px grid, 1.8 stroke, round caps) so none stands out. */
const NAV_PATHS: Record<string, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  actions: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12.2 2.8 2.8L16.5 9" />
    </>
  ),
  agents: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 6M17.5 14.8c1.6.7 2.7 2.3 3 4.7" />
    </>
  ),
  schedules: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  permissions: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8 7.5 9.5 4.4-1.5 7.5-5.1 7.5-9.5V6z" />
      <circle cx="12" cy="11" r="1.8" />
      <path d="M12 12.8V15.5" />
    </>
  ),
  tech: (
    <>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" />
    </>
  ),
  knowledge: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  insights: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
};

export function NavIcon({ id, size = 17 }: { id: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {NAV_PATHS[id]}
    </svg>
  );
}

/** Local model family, from the Ollama model name (logos in modelLogos.tsx). */
export function modelFamily(model: string): "gemma" | "mistral" | "qwen" | "llama" | "phi" | "deepseek" | "other" {
  const m = model.toLowerCase().split("/").at(-1) ?? "";
  if (m.startsWith("gemma")) return "gemma";
  if (m.startsWith("mistral") || m.startsWith("ministral") || m.startsWith("mixtral") || m.startsWith("devstral")) return "mistral";
  if (m.startsWith("qwen") || m.startsWith("qwq")) return "qwen";
  if (m.startsWith("llama")) return "llama";
  if (m.startsWith("phi")) return "phi";
  if (m.startsWith("deepseek")) return "deepseek";
  return "other";
}

export function ModelIcon({ model, size = 15, thinking }: { model: string; size?: number; thinking?: boolean }) {
  const family = modelFamily(model);
  const mark = MODEL_LOGOS[family] ?? (
    <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
  );
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size + 6, height: size + 6 }} title={thinking ? `${model} is thinking…` : model}>
      {thinking && <span className="absolute inset-0 animate-spin rounded-full border-2 border-accent/25 border-t-accent motion-reduce:animate-none" aria-hidden />}
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        {mark}
      </svg>
      {thinking && <span className="sr-only">{model} is thinking</span>}
    </span>
  );
}
