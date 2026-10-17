import type { Skill } from "./assistant";

/** Shared with the prompt bar (no server code here): the kinds of request offered under an answer ("not right?"). */
export const CHOICES: { skill: Skill; label: string }[] = [
  { skill: "agenda", label: "A calendar question" },
  { skill: "add_event", label: "Add to my calendar" },
  { skill: "reminder", label: "A reminder for me" },
  { skill: "email_question", label: "Answer it from my mail" },
  { skill: "email_search", label: "Find emails" },
  { skill: "inbox_review", label: "What needs me in my mail" },
  { skill: "draft_reply", label: "Write a reply" },
  { skill: "nudge", label: "Follow up with someone" },
  { skill: "waiting_on", label: "Who owes me a reply" },
  { skill: "notes_search", label: "From my notes" },
  { skill: "web_search", label: "Search the web" },
  { skill: "weather", label: "The weather" },
  { skill: "trips", label: "My trips and bookings" },
  { skill: "event_from_email", label: "An event from my mail, into the calendar" },
  { skill: "priorities", label: "What to do first" },
  { skill: "reminders_list", label: "My reminders" },
];
export const CHOICE_SKILLS = CHOICES.map((c) => c.skill) as [Skill, ...Skill[]];

/** The words shown for the skill that answered, when it has some. */
export function choiceLabel(skill?: string): string | undefined {
  return CHOICES.find((c) => c.skill === skill)?.label;
}
