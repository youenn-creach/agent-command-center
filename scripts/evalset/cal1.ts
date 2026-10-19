import type { EvalItem } from "./types";

/**
 * Calendar questions (written 2026-10-18 evening, before any run): for the experiment where the model answers calendar
 * questions the rules can only list (assistant.calendarModel). Run with it off, then on, on the same frozen code. NEVER tune
 * on it. The calendar of the evaluation world (Thu 15 Oct 2026, 10:30 Madrid): Thu Dentist 09:30-10:00 (Riverside Dental),
 * Lunch with Sam 12:30-13:30 (Café Lumen), garden committee 18:00-19:30 (Library meeting room); Fri bike drop-off 08:15-08:30
 * (Spokes & Co, Canal Street), Spanish exchange 19:00-20:00 (Library café); Sun long run 08:00-09:40. Nothing else.
 */
const T = "test" as const;
const C = "calendar-question" as const;

export const EVALSET_CAL1: EvalItem[] = [
  { id: "K01", split: T, cat: C, text: "is there a free slot between lunch and the committee", must: [/13:30.{0,12}18:00|free|yes/i], want: "Yes, 13:30-18:00." },
  { id: "K02", split: T, cat: C, text: "how many appointments do I have today", must: [/\b3\b|three/i], want: "Three." },
  { id: "K03", split: T, cat: C, text: "what's the last thing on my calendar today", must: [/committee/i], want: "The committee 18:00." },
  { id: "K04", split: T, cat: C, text: "what's my earliest appointment tomorrow", must: [/08:15|8:15|bike/i], want: "The bike drop-off 08:15." },
  { id: "K05", split: T, cat: C, text: "what time am I done for the day", must: [/19:30/], want: "19:30." },
  { id: "K06", split: T, cat: C, text: "am I busy at 1pm today", must: [/yes|lunch|busy/i], want: "Yes: lunch with Sam." },
  { id: "K07", split: T, cat: C, text: "what time did the dentist end", must: [/10:00/], want: "10:00." },
  { id: "K08", split: T, cat: C, text: "is my evening free tomorrow", must: [/\bno\b|Spanish|19:00/i], want: "No: the Spanish exchange 19:00." },
  { id: "K09", split: T, cat: C, text: "how long does the spanish exchange last", must: [/1 hour|one hour|an hour|60 min|19:00.{0,5}20:00/i], want: "An hour, 19:00-20:00." },
  { id: "K10", split: T, cat: C, text: "what's between 2pm and 5pm today", must: [/nothing|free|no events|0 events/i], never: [/committee|Lunch/i], want: "Nothing." },
  { id: "K11", split: T, cat: C, text: "do I have anything before 9 tomorrow", must: [/08:15|8:15|bike/i], want: "The bike drop-off 08:15." },
  { id: "K12", split: T, cat: C, text: "which day is the long run", must: [/Sun/i], want: "Sunday." },
  { id: "K13", split: T, cat: C, text: "how much free time do I have this afternoon", must: [/13:30|18:00|4\.5|four and a half|4 h|4h30|4 hours 30/i], want: "13:30-18:00." },
  { id: "K14", split: T, cat: C, text: "does anything clash today", must: [/\bno\b|nothing|not|none/i], want: "No overlaps." },
  { id: "K15", split: T, cat: C, text: "what's the first thing after lunch", must: [/committee|18:00/i], want: "The committee 18:00." },
  { id: "K16", split: T, cat: C, text: "how many hours of appointments do I have today", must: [/\b3\b|three/i], want: "Three hours." },
  { id: "K17", split: T, cat: C, text: "is saturday completely free", must: [/free|nothing|no events|yes/i], never: [/Long run/], want: "Yes (only the hike mail mentions it)." },
  { id: "K18", split: T, cat: C, text: "what comes after the committee", must: [/08:15|bike|Spanish|tomorrow|Fri/i], want: "Tomorrow's bike drop-off 08:15." },
  { id: "K19", split: T, cat: C, text: "what time does the committee start", must: [/18:00|6 ?pm/i], want: "18:00." },
  { id: "K20", split: T, cat: C, text: "where am I going after lunch", must: [/committee|Library/i], want: "The committee at the library." },
  { id: "K21", split: T, cat: C, text: "is there time for a nap before lunch", must: [/yes|free|10:30|12:30/i], want: "Yes, free until 12:30." },
  { id: "K22", split: T, cat: C, text: "how long is lunch", must: [/1 hour|one hour|an hour|60 min|12:30.{0,5}13:30/i], want: "An hour." },
  { id: "K23", split: T, cat: C, text: "what do I have between friday and sunday", must: [/bike|Spokes/i, /Long run/i], want: "Bike drop-off, Spanish exchange, long run." },
  { id: "K24", split: T, cat: C, text: "when does the bike drop-off end", must: [/08:30|8:30/], want: "08:30." },
  { id: "K25", split: T, cat: C, text: "how many things are on sunday", must: [/\b1\b|one|single/i], want: "One: the long run." },
  { id: "K26", split: T, cat: C, text: "is the dentist done already", must: [/yes|already|over|ended|10:00/i], want: "Yes, it ended at 10:00." },
  { id: "K27", split: T, cat: C, text: "which day this week is the busiest", must: [/today|Thu|15/i], want: "Today (three events)." },
  { id: "K28", split: T, cat: C, text: "do I have two things at the same time tomorrow", must: [/\bno\b|not|nothing|none/i], want: "No." },
  { id: "K29", split: T, cat: C, text: "how early does the long run start", must: [/08:00|8:00|8 ?am/i], want: "08:00." },
  { id: "K30", split: T, cat: C, text: "what's the gap between the dentist and lunch", must: [/10:00.{0,12}12:30|2 ?h|two hours|2.5|two and a half/i], want: "10:00-12:30." },
];
