import type { AccessLevel } from "./levels";

/**
 * Role profiles: the most each agent could ever need on each service, derived from what its code
 * actually does. Grants above a profile are refused, clamped by the policy engine, and trimmed on
 * startup — so a mis-click (or an edited database) can't hand an agent access its role never uses.
 *
 * Update this when an agent gains a new tool; the tests check every seeded grant fits.
 */
const PROFILES: Record<string, Record<string, AccessLevel>> = {
  // Coordinates workflows only; never touches data itself.
  chief_of_staff: {},
  inbox: {
    "demo-mail": "read",
    gmail: "read",
  },
  calendar: {
    "demo-calendar": "write_with_approval",
    "google-calendar": "read",
    // Creates approved events in the app's own Google calendar (never the main one).
    "google-calendar-app": "write_with_approval",
    weather: "read",
  },
  follow_up: {
    "demo-mail": "write_with_approval",
    "local-tasks": "write_with_approval",
    gmail: "read",
    "gmail-drafts": "write_with_approval",
  },
  knowledge: {
    "demo-notes": "read",
    "public-news": "read",
    // Searches the web and reads public pages for Ctrl+K questions (the user's own SearXNG).
    "web-search": "read",
  },
};

/** Webhooks are proposed by the Follow-up agent only (Ctrl+K "trigger …"). */
function dynamicProfile(agentId: string, serviceId: string): AccessLevel | null {
  if (serviceId.startsWith("hook-")) return agentId === "follow_up" ? "write_with_approval" : "none";
  return null;
}

export function agentMaxLevel(agentId: string, serviceId: string): AccessLevel {
  return dynamicProfile(agentId, serviceId) ?? PROFILES[agentId]?.[serviceId] ?? "none";
}

const AGENT_NAMES: Record<string, string> = {
  chief_of_staff: "The Chief of Staff only coordinates and never uses services itself",
};

export function profileReason(agentId: string, serviceId: string, agentName: string, serviceName: string): string {
  if (agentMaxLevel(agentId, serviceId) !== "none") return "";
  return AGENT_NAMES[agentId] ?? `${agentName} never uses ${serviceName}`;
}
