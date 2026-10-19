import type { EvalItem } from "./types";

/**
 * Calendar questions, second set (written 2026-10-18 late evening, before any run of the computed calendar answers in
 * f443a54): a FRESH held-out measure of them, compared with cal1's 21/30 on the rules before. NEVER tune on it. The calendar
 * of the evaluation world is listed in cal1.ts (Thu 15 Oct 2026, 10:30 Madrid). No text shared with v1-v6, cal1 or the code.
 */
const T = "test" as const;
const C = "calendar-question" as const;

export const EVALSET_CAL2: EvalItem[] = [
  { id: "L01", split: T, cat: C, text: "how much free time is there before the committee", must: [/13:30|10:30|12:30|18:00/], want: "10:30-12:30 and 13:30-18:00." },
  { id: "L02", split: T, cat: C, text: "what's on between 11am and 3pm", must: [/Lunch/i], never: [/committee/i], want: "Lunch with Sam 12:30." },
  { id: "L03", split: T, cat: C, text: "is anything on between 8pm and 10pm tonight", must: [/nothing|free|no events/i], want: "Nothing." },
  { id: "L04", split: T, cat: C, text: "how much time is there between lunch and the committee", must: [/13:30.{0,12}18:00|4 h 30|4\.5|four and a half/i], want: "4 h 30 min." },
  { id: "L05", split: T, cat: C, text: "how many hours am I booked tomorrow", must: [/1 h 15|75 min|1 hour 15|1\.25|an hour and a quarter/i], want: "1 h 15 min (15 min + 1 h)." },
  { id: "L06", split: T, cat: C, text: "what's after the spanish exchange", must: [/Long run|Sun/i], want: "The long run, Sunday 08:00." },
  { id: "L07", split: T, cat: C, text: "what have I got from saturday to sunday", must: [/Long run/i], never: [/committee|Spanish/i], want: "The long run on Sunday." },
  { id: "L08", split: T, cat: C, text: "any breaks this morning", must: [/free|10:00|12:30|10:30/i], want: "Free until 12:30." },
  { id: "L09", split: T, cat: C, text: "what time is my first appointment today", must: [/09:30|9:30/], want: "09:30 (the dentist, over)." },
  { id: "L10", split: T, cat: C, text: "how many events do I have on friday", must: [/\b2\b|two/i], want: "Two." },
  { id: "L11", split: T, cat: C, text: "where am I headed after the bike drop-off", must: [/Spanish|Library/i], want: "The Spanish exchange, library café." },
  { id: "L12", split: T, cat: C, text: "is there a clash anywhere this week", must: [/\bno\b|nothing|not|none/i], want: "No overlaps." },
  { id: "L13", split: T, cat: C, text: "when's my last event tomorrow", must: [/19:00|Spanish/i], want: "The Spanish exchange 19:00." },
  { id: "L14", split: T, cat: C, text: "what's happening on the 18th", must: [/Long run/i], want: "The long run." },
  { id: "L15", split: T, cat: C, text: "do I have a free hour this afternoon", must: [/yes|free|13:30|18:00/i], want: "Yes, 13:30-18:00." },
  { id: "L16", split: T, cat: C, text: "what is planned for thursday evening", must: [/committee/i], want: "The committee 18:00." },
  { id: "L17", split: T, cat: C, text: "is the committee in the library", must: [/yes|Library/i], want: "Yes, the library meeting room." },
  { id: "L18", split: T, cat: C, text: "at what time should I leave for the dentist", must: [/09:30|9:30|already|over|past/i], want: "It was at 09:30 (already over)." },
  { id: "L19", split: T, cat: C, text: "what's the gap between the bike drop-off and the spanish exchange", must: [/08:30.{0,12}19:00|10 h 30|10\.5/i], want: "08:30-19:00." },
  { id: "L20", split: T, cat: C, text: "how much of today is booked", must: [/3 hours|three hours|\b3 h/i], want: "3 hours." },
  { id: "L21", split: T, cat: C, text: "what's my schedule from friday to saturday", must: [/bike|Spokes/i, /Spanish/i], want: "The bike drop-off and the Spanish exchange." },
  { id: "L22", split: T, cat: C, text: "is the morning of sunday busy", must: [/yes|long run|08:00/i], want: "Yes: the long run 08:00." },
  { id: "L23", split: T, cat: C, text: "when does my day start tomorrow", must: [/08:15|8:15/], want: "08:15." },
  { id: "L24", split: T, cat: C, text: "what's coming up after lunch", must: [/committee/i], want: "The committee 18:00." },
  { id: "L25", split: T, cat: C, text: "is 4pm tomorrow free", must: [/yes|free/i], want: "Yes." },
  { id: "L26", split: T, cat: C, text: "which events are in the library", must: [/committee|Spanish/i], want: "The committee and the Spanish exchange." },
  { id: "L27", split: T, cat: C, text: "how long do I have between the dentist and the committee", must: [/10:00.{0,12}18:00|8 hours|8 h|free/i], want: "Free except lunch: 10:00-12:30 and 13:30-18:00." },
  { id: "L28", split: T, cat: C, text: "anything late on friday", must: [/Spanish|19:00/i], want: "The Spanish exchange 19:00." },
  { id: "L29", split: T, cat: C, text: "how many things this weekend", must: [/\b1\b|one/i], want: "One: the long run." },
  { id: "L30", split: T, cat: C, text: "what's the next event after the long run", must: [/nothing|no (?:more|other|events)|none/i], want: "Nothing more this week." },
];
