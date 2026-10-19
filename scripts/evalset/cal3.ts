import type { EvalItem } from "./types";

/**
 * Calendar questions, third set (written 2026-10-19 early morning, before any run of 98f2665): a FRESH held-out measure of
 * the computed calendar answers after cal2's fixes (cal1 on the old rules: 21/30; cal2 on f443a54: 23/30). NEVER tune on it.
 * The calendar of the evaluation world is listed in cal1.ts. No text shared with v1-v6, cal1, cal2 or the code.
 */
const T = "test" as const;
const C = "calendar-question" as const;

export const EVALSET_CAL3: EvalItem[] = [
  { id: "M01", split: T, cat: C, text: "how much spare time have I got between lunch and the garden committee", must: [/13:30.{0,12}18:00|4 h 30|4\.5/i], want: "4 h 30 min." },
  { id: "M02", split: T, cat: C, text: "anything on between 1pm and 4pm tomorrow", must: [/nothing|free|no events/i], want: "Nothing." },
  { id: "M03", split: T, cat: C, text: "what's on from 6pm to 8pm today", must: [/committee/i], want: "The committee." },
  { id: "M04", split: T, cat: C, text: "how packed is tomorrow", must: [/1 h 15|2 events|two|75 min/i], want: "Two events, 1 h 15 min." },
  { id: "M05", split: T, cat: C, text: "what happens after the bike drop-off", must: [/Spanish|19:00/i], want: "The Spanish exchange 19:00." },
  { id: "M06", split: T, cat: C, text: "what's on from friday to sunday", must: [/bike|Spokes/i, /Long run/i], want: "Bike drop-off, Spanish exchange, long run." },
  { id: "M07", split: T, cat: C, text: "when's my next free afternoon", must: [/today|tomorrow|free|Fri|Sat/i], want: "Today from 13:30 (or tomorrow)." },
  { id: "M08", split: T, cat: C, text: "how many meetings today", must: [/\b3\b|three/i], want: "Three." },
  { id: "M09", split: T, cat: C, text: "is the spanish exchange at the library cafe", must: [/yes|Library caf/i], want: "Yes." },
  { id: "M10", split: T, cat: C, text: "am I around at 11am tomorrow", must: [/yes|free/i], want: "Yes, free." },
  { id: "M11", split: T, cat: C, text: "is 6:30pm today free", must: [/\bno\b|committee|busy/i], want: "No: the committee." },
  { id: "M12", split: T, cat: C, text: "what's the free time between the committee and the bike drop-off", must: [/19:30.{0,40}08:15|12 h 45|free/i], want: "19:30 today to 08:15 tomorrow." },
  { id: "M13", split: T, cat: C, text: "what's the first event on sunday", must: [/Long run|08:00/i], want: "The long run 08:00." },
  { id: "M14", split: T, cat: C, text: "what do I have later this evening", must: [/committee/i], never: [/Lunch/], want: "The committee 18:00." },
  { id: "M15", split: T, cat: C, text: "how long is the long run", must: [/1 h 40|100 min|08:00.{0,5}09:40|16 ?km/i], want: "1 h 40 min, 16 km." },
  { id: "M16", split: T, cat: C, text: "what comes before lunch today", must: [/Dentist|09:30/i], want: "The dentist (over)." },
  { id: "M17", split: T, cat: C, text: "is there room for a coffee before the committee", must: [/yes|free|13:30|18:00/i], want: "Yes." },
  { id: "M18", split: T, cat: C, text: "what's the next thing after the dentist", must: [/Lunch|12:30/i], want: "Lunch 12:30." },
  { id: "M19", split: T, cat: C, text: "do I have plans on sunday afternoon", must: [/nothing|free|no events|\bno\b/i], never: [/committee/i], want: "Nothing (the run is in the morning)." },
  { id: "M20", split: T, cat: C, text: "how much free time do I have tomorrow", must: [/free|08:30|19:00|20:00/i], want: "Most of the day." },
  { id: "M21", split: T, cat: C, text: "where do I need to be at 6pm", must: [/Library meeting room|committee/i], want: "The library meeting room." },
  { id: "M22", split: T, cat: C, text: "how many events are left today", must: [/\b2\b|two/i], want: "Two." },
  { id: "M23", split: T, cat: C, text: "what time is the last event this week", must: [/08:00|Long run|Sun/i], want: "The long run Sunday 08:00." },
  { id: "M24", split: T, cat: C, text: "is friday morning free", must: [/08:15|bike|\bno\b|free/i], want: "Free after the 08:15 drop-off." },
  { id: "M25", split: T, cat: C, text: "how much time between the spanish exchange and the long run", must: [/20:00.{0,40}08:00|36 h|free/i], want: "Fri 20:00 to Sun 08:00." },
  { id: "M26", split: T, cat: C, text: "is there anything at noon tomorrow", must: [/\bno\b|free|nothing/i], want: "No." },
  { id: "M27", split: T, cat: C, text: "who am I seeing for lunch and where", must: [/Sam/, /Lumen/i], want: "Sam at Café Lumen." },
  { id: "M28", split: T, cat: C, text: "what's after the lunch with sam", must: [/committee|18:00/i], want: "The committee 18:00." },
  { id: "M29", split: T, cat: C, text: "is my calendar empty on monday", must: [/yes|empty|nothing|free/i], want: "Yes." },
  { id: "M30", split: T, cat: C, text: "how many hours is the committee", must: [/1 h 30|1\.5|90 min|an hour and a half|18:00.{0,5}19:30/i], want: "1 h 30 min." },
];
