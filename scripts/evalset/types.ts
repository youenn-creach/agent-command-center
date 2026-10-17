/**
 * The fixed evaluation set: requests with machine-checkable expectations, graded automatically (scripts/eval-run.mts).
 * Facts are those of the fictional demo data and the fake Gmail (scripts/sim-gmail.ts), at the evaluation clock
 * Thu 15 Oct 2026, 10:30 in Madrid (SIM_NOW=2026-10-15T08:30:00Z). See docs/ACCURACY_PLAN.md.
 */
export type Category =
  | "calendar-question"
  | "calendar-add"
  | "reminder"
  | "mail-question"
  | "mail-action"
  | "notes"
  | "web"
  | "trips"
  | "two-asks"
  | "vague-unsupported"
  | "summary";

export interface EvalItem {
  id: string;
  split: "dev" | "test";
  cat: Category;
  text: string;
  /** Final skills accepted (the request's intent after everything); omitted when any route giving the right result is fine. */
  skills?: string[];
  /** Must all appear in what the user gets: the answer, its items, prepared actions, reminders and events (as text lines). */
  must?: RegExp[];
  /** Must not appear there (an invented fact, a wrong date, an obeyed injection). */
  never?: RegExp[];
  /** Reminders the request must create: how many, and optionally the local due "YYYY-MM-DD HH:MM" prefix of the first. */
  reminders?: { count: number; due?: string; text?: RegExp };
  /** Actions waiting for approval afterwards (follow-ups, drafts when queued): a number, or "none". */
  actions?: number | "none";
  /** A short note for the reader: what the user would want. */
  want: string;
}

export interface EvalResult {
  id: string;
  split: string;
  cat: Category;
  text: string;
  intent: string;
  asked: boolean;
  ms: number;
  shown: string;
  pass: boolean;
  /** Why it failed: asked | understanding (wrong skill) | missing (a required fact or result absent) | forbidden (a fact that must not appear) | reminders | actions | error */
  fails: string[];
}
