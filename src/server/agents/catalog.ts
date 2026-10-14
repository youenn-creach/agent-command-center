import type { Requirement } from "../scheduler/scheduler";

/**
 * The workflows a user can schedule. Requirements, sources and destination come from here —
 * never from the request — so creating a schedule cannot widen what an agent may touch.
 * (`insurance_reminder` is a demo one-off and is deliberately not offered.)
 */
export interface CatalogEntry {
  workflow: string;
  name: string;
  description: string;
  agentId: string;
  sources: string[];
  destination: string;
  requirements: Requirement[];
  defaultCron: string;
}

export const WORKFLOW_CATALOG: CatalogEntry[] = [
  {
    workflow: "daily_briefing",
    name: "Morning briefing",
    description: "Agenda, messages waiting on you, and a digest of your news sources, delivered to Today.",
    agentId: "chief_of_staff",
    sources: ["Public news", "Calendar", "Inbox (headers only)"],
    destination: "Dashboard → Today",
    requirements: [{ agentId: "knowledge", serviceId: "public-news", level: "read" }],
    defaultCron: "30 8 * * 1-5",
  },
  {
    workflow: "followup_sweep",
    name: "Follow-up sweep",
    description: "Drafts holding replies for messages still waiting on you. Drafts wait for approval.",
    agentId: "follow_up",
    sources: ["Inbox (headers only)"],
    destination: "Action Queue (drafts only)",
    requirements: [
      { agentId: "inbox", serviceId: "demo-mail", level: "read" },
      { agentId: "follow_up", serviceId: "demo-mail", level: "prepare" },
    ],
    defaultCron: "0 16 * * 5",
  },
  {
    workflow: "weekly_review",
    name: "Weekly review",
    description: "Next 7 days, what is still pending, and what the agents did last week.",
    agentId: "chief_of_staff",
    sources: ["Calendar", "Inbox (headers only)", "Dashboard history"],
    destination: "Dashboard → Today",
    requirements: [
      { agentId: "calendar", serviceId: "demo-calendar", level: "read" },
      { agentId: "inbox", serviceId: "demo-mail", level: "read" },
    ],
    defaultCron: "0 18 * * 0",
  },
];

export function catalogEntry(workflow: string): CatalogEntry | undefined {
  return WORKFLOW_CATALOG.find((w) => w.workflow === workflow);
}
