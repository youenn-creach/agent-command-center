import type { EvalItem } from "./types";

/**
 * Evaluation set v5 (written 2026-10-18, before any run of the v4 fixes): a FRESH held-out test set. v4's failures were
 * studied and fixed (5ec5b2e), so v4 is tuning material; v5 is the honest measure. NEVER tune on v5. Same fictional world
 * and clock as v1 (see the facts in v1.ts): Thu 15 Oct 2026, 10:30 Madrid. No text shared with v1-v4 or the example library.
 */
const T = "test" as const;

export const EVALSET_V5: EvalItem[] = [
  // calendar questions
  { id: "X01", split: T, cat: "calendar-question", text: "what's still to come today", must: [/committee/i], never: [/Dentist/], want: "Lunch and the committee." },
  { id: "X02", split: T, cat: "calendar-question", text: "which street is the bike place on", must: [/Canal Street/i], want: "Canal Street." },
  { id: "X03", split: T, cat: "calendar-question", text: "when does lunch end", must: [/13:30/], want: "13:30." },
  { id: "X04", split: T, cat: "calendar-question", text: "is the spanish exchange tonight or tomorrow", must: [/tomorrow|Fri/i], want: "Tomorrow 19:00." },
  { id: "X05", split: T, cat: "calendar-question", text: "how many things do I have on tomorrow", must: [/\b2\b|two/i], want: "Two." },
  { id: "X06", split: T, cat: "calendar-question", text: "what's planned for the weekend", must: [/long run/i], want: "The Sunday long run (and the hike mail)." },
  { id: "X07", split: T, cat: "calendar-question", text: "do I have a gap this afternoon", must: [/free|nothing|gap|until 18/i], want: "Free 13:30–18:00." },
  { id: "X08", split: T, cat: "calendar-question", text: "what time does the long run start", must: [/08:00|8:00|8 ?am/i], want: "08:00 Sunday." },
  // adding to the calendar
  { id: "X09", split: T, cat: "calendar-add", text: "add a dinner with Carla on friday at 9pm", must: [/EVENT .*Carla.* 2026-10-16T21:00/i], want: "Dinner with Carla Fri 16 Oct 21:00." },
  { id: "X10", split: T, cat: "calendar-add", text: "put physio on monday at 8am", must: [/EVENT .*physio.* 2026-10-19T08:00/i], want: "Physio Mon 19 Oct 08:00." },
  { id: "X11", split: T, cat: "calendar-add", text: "can you schedule a call with the accountant on the 28th at 11am", must: [/EVENT .*accountant.* 2026-10-28T11:00/i], want: "Call with the accountant Wed 28 Oct 11:00." },
  { id: "X12", split: T, cat: "calendar-add", text: "add the school concert on november 12 at 6:30pm", must: [/EVENT .*concert.* 2026-11-12T18:30/i], want: "School concert Thu 12 Nov 18:30." },
  { id: "X13", split: T, cat: "calendar-add", text: "add maria's saturday hike to the calendar", must: [/17 Oct|2026-10-17|Sat/i, /08:00|8am|8:00/i], want: "From Maria's mail: Sat 17 Oct 08:00." },
  { id: "X14", split: T, cat: "calendar-add", text: "put a haircut next wednesday at half past four", must: [/EVENT .*haircut.* 2026-10-21T16:30/i], want: "Haircut Wed 21 Oct 16:30." },
  // reminders
  { id: "X15", split: T, cat: "reminder", text: "remind me to renew my gym card on the 1st", reminders: { count: 1, due: "2026-11-01 09:00", text: /gym/i }, want: "Sun 1 Nov 09:00." },
  { id: "X16", split: T, cat: "reminder", text: "remind me at 6 to start dinner", reminders: { count: 1, due: "2026-10-15 18:00", text: /dinner/i }, want: "Today 18:00." },
  { id: "X17", split: T, cat: "reminder", text: "remind me in 45 minutes to check the washing", reminders: { count: 1, due: "2026-10-15 11:1", text: /washing/i }, want: "Today 11:15." },
  { id: "X18", split: T, cat: "reminder", text: "set a reminder for tomorrow evening to call grandad", reminders: { count: 1, due: "2026-10-16 18:00", text: /grandad/i }, want: "Fri 18:00." },
  { id: "X19", split: T, cat: "reminder", text: "remind me the morning of the long run to eat breakfast early", reminders: { count: 1, due: "2026-10-18 0", text: /breakfast/i }, want: "Sun 18 Oct, before 08:00." },
  { id: "X20", split: T, cat: "reminder", text: "remind me on wednesday at 2pm to post the letter", reminders: { count: 1, due: "2026-10-21 14:00", text: /letter/i }, want: "Wed 21 Oct 14:00." },
  { id: "X21", split: T, cat: "reminder", text: "make sure I remember to buy a birthday card on friday", reminders: { count: 1, due: "2026-10-16 09:00", text: /birthday card/i }, want: "Fri 16 Oct 09:00." },
  { id: "X22", split: T, cat: "reminder", text: "what's on my to-do list", must: [/no open reminders|no reminders/i], reminders: { count: 0 }, want: "None open (the world starts empty)." },
  // mail questions
  { id: "X23", split: T, cat: "mail-question", text: "what time are we leaving for the hike", must: [/\b8\b|08:00|8 ?am/i], want: "8am." },
  { id: "X24", split: T, cat: "mail-question", text: "what day is the boiler man coming", must: [/Tue|20 Oct|\b20\b/i], want: "Tue 20 Oct." },
  { id: "X25", split: T, cat: "mail-question", text: "did I get anything from the bank", must: [/statement/i], want: "Yes: the statement is ready." },
  { id: "X26", split: T, cat: "mail-question", text: "what's jordan asking me to do", must: [/book|vote|pick|choose/i], want: "Pick a book for November." },
  { id: "X27", split: T, cat: "mail-question", text: "how much will my car insurance cost this year", must: [/412/], want: "412 EUR." },
  { id: "X28", split: T, cat: "mail-question", text: "is tom still ignoring me", must: [/not yet|still waiting|\bno\b|hasn'?t|yes/i, /Tom/i], want: "Still waiting on Tom (4 days)." },
  { id: "X29", split: T, cat: "mail-question", text: "what's the latest email from maria about", must: [/hike/i], want: "The Saturday hike." },
  { id: "X30", split: T, cat: "mail-question", text: "anything in my inbox I need to answer", must: [/Maria|landlord|boiler|hike/i], want: "Maria's hike and the landlord's slot." },
  // mail actions
  { id: "X31", split: T, cat: "mail-action", text: "tell maria yes I'm in for saturday", must: [/reply to .*maria/i], want: "A draft to Maria." },
  { id: "X32", split: T, cat: "mail-action", text: "reply to the landlord asking if the afternoon works instead", must: [/reply to .*landlord/i], want: "A draft to the landlord." },
  { id: "X33", split: T, cat: "mail-action", text: "remind priya I'm still waiting on the quote", must: [/Priya/], actions: 1, want: "One follow-up to Priya." },
  { id: "X34", split: T, cat: "mail-action", text: "chase up everyone who hasn't got back to me", actions: 2, want: "Two follow-ups (Priya, Tom)." },
  { id: "X35", split: T, cat: "mail-action", text: "let jordan know I'd rather read the first one", must: [/reply to .*jordan/i], want: "A draft to Jordan." },
  { id: "X36", split: T, cat: "mail-action", text: "write tom a quick follow-up about the photos", must: [/Tom/], actions: 1, want: "One follow-up to Tom." },
  // notes
  { id: "X37", split: T, cat: "notes", text: "which kitchen quote is cheaper", must: [/\bA\b|6,?900/], want: "Quote A, 6,900 EUR." },
  { id: "X38", split: T, cat: "notes", text: "what's my target for the half marathon", must: [/1h55|1:55|1 hour 55|55 min/i], want: "Under 1h55." },
  { id: "X39", split: T, cat: "notes", text: "what's the garden committee's membership fee about", must: [/fee/i], want: "A possible membership fee." },
  { id: "X40", split: T, cat: "notes", text: "what am I struggling with in spanish", must: [/subjunctive/i], want: "The subjunctive." },
  { id: "X41", split: T, cat: "notes", text: "how often should I feed the sourdough starter", must: [/week/i], want: "Once a week." },
  // the web
  { id: "X42", split: T, cat: "web", text: "how many days are in a leap year", must: [/366/], want: "366." },
  { id: "X43", split: T, cat: "web", text: "who wrote romeo and juliet", must: [/Shakespeare/i], want: "Shakespeare." },
  { id: "X44", split: T, cat: "web", text: "what's the largest planet in the solar system", must: [/Jupiter/i], want: "Jupiter." },
  // trips
  { id: "X45", split: T, cat: "trips", text: "when am I going to lisbon", must: [/7 Nov|Sat/i], want: "Sat 7 Nov." },
  { id: "X46", split: T, cat: "trips", text: "what are my upcoming bookings", must: [/Alfama|LIS|Lisbon/i], want: "The Lisbon flight and the Alfama stay." },
  { id: "X47", split: T, cat: "trips", text: "what time does my plane leave", must: [/07:40|7:40/], want: "07:40 Sat 7 Nov." },
  // two requests in one
  { id: "X48", split: T, cat: "two-asks", text: "where's the committee and remind me at 5 to leave", must: [/Library/i], reminders: { count: 1, due: "2026-10-15 17:00", text: /leave/i }, want: "Library meeting room; a reminder 17:00." },
  { id: "X49", split: T, cat: "two-asks", text: "has tom answered and if he hasn't chase him", must: [/Tom/i], actions: 1, want: "Not yet; one follow-up to Tom." },
  { id: "X50", split: T, cat: "two-asks", text: "how much is quote B and what does it include", must: [/7,?600/, /sink/i], want: "7,600 EUR; moving the sink." },
  { id: "X51", split: T, cat: "two-asks", text: "add tennis on saturday at 10am and remind me friday night to find my racket", must: [/EVENT .*tennis.* 2026-10-17T10:00/i], reminders: { count: 1, due: "2026-10-16 20:00", text: /racket/i }, want: "Tennis Sat 17 Oct 10:00; a reminder Fri 20:00." },
  { id: "X52", split: T, cat: "two-asks", text: "what's my flight time and which neighbourhood is the hotel in", must: [/07:40|7:40/, /Alfama/i], want: "07:40; Alfama." },
  { id: "X53", split: T, cat: "two-asks", text: "what's happening tomorrow and remind me in the morning to take the bike", must: [/Spokes|bike|Spanish/i], reminders: { count: 1, due: "2026-10-16 09:00", text: /bike/i }, want: "Friday's events; a reminder Fri 09:00." },
  { id: "X54", split: T, cat: "two-asks", text: "what did the landlord say and reply that tuesday is fine", must: [/boiler|inspection/i, /reply to .*landlord/i], want: "The inspection; a draft to the landlord." },
  { id: "X55", split: T, cat: "two-asks", text: "what's on monday and remind me sunday evening to prepare lunch", reminders: { count: 1, due: "2026-10-18 18:00", text: /lunch/i }, want: "Monday's calendar; a reminder Sun 18:00." },
  // things the app can't do
  { id: "X56", split: T, cat: "vague-unsupported", text: "buy me some running shoes", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't buy; nothing prepared." },
  { id: "X57", split: T, cat: "vague-unsupported", text: "cancel my netflix subscription", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  { id: "X58", split: T, cat: "vague-unsupported", text: "open the garage door", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  // summaries
  { id: "X59", split: T, cat: "summary", text: "sum up my day for me", must: [/Lunch|committee/i], want: "Today's lunch and committee." },
  { id: "X60", split: T, cat: "summary", text: "what needs my attention this morning", must: [/Maria|landlord|boiler|hike|Lunch|committee/i], want: "Maria's hike, the landlord's slot, today's events." },
];
