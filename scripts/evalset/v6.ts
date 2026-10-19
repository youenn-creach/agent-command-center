import type { EvalItem } from "./types";

/**
 * Evaluation set v6 (written 2026-10-18 evening, before any run of the v5 fixes, the review fixes or the calendar
 * experiment): a FRESH held-out test set, same mix as v3-v5. NEVER tune on v6. Same fictional world and clock as v1 (see
 * the facts in v1.ts and cal1.ts): Thu 15 Oct 2026, 10:30 Madrid. No text shared with v1-v5, cal1 or the code.
 */
const T = "test" as const;

export const EVALSET_V6: EvalItem[] = [
  // calendar questions
  { id: "Y01", split: T, cat: "calendar-question", text: "what am I up to later today", must: [/committee/i], never: [/Dentist/], want: "Lunch and the committee." },
  { id: "Y02", split: T, cat: "calendar-question", text: "where's the dentist", must: [/Riverside/i], want: "Riverside Dental." },
  { id: "Y03", split: T, cat: "calendar-question", text: "what time is the spanish thing on friday", must: [/19:00|7 ?pm/i], want: "19:00." },
  { id: "Y04", split: T, cat: "calendar-question", text: "is anything booked for monday", must: [/nothing|free|no events|\bno\b/i], never: [/committee|Spanish|Lunch/i], want: "Nothing." },
  { id: "Y05", split: T, cat: "calendar-question", text: "who's the lunch with", must: [/Sam/], want: "Sam." },
  { id: "Y06", split: T, cat: "calendar-question", text: "when exactly is the bike appointment", must: [/08:15|8:15/], want: "Fri 08:15." },
  { id: "Y07", split: T, cat: "calendar-question", text: "what's on the schedule for sunday morning", must: [/long run|08:00/i], want: "The long run 08:00." },
  { id: "Y08", split: T, cat: "calendar-question", text: "am I free tonight", must: [/\bno\b|committee|18:00/i], want: "No: the committee 18:00-19:30." },
  // adding to the calendar
  { id: "Y09", split: T, cat: "calendar-add", text: "add a dentist follow up on the 4th of november at 9am", must: [/EVENT .*dentist.* 2026-11-04T09:00/i], want: "Wed 4 Nov 09:00." },
  { id: "Y10", split: T, cat: "calendar-add", text: "put drinks with the team on thursday next week at 6pm", must: [/EVENT .*drinks.* 2026-10-22T18:00/i], want: "Thu 22 Oct 18:00." },
  { id: "Y11", split: T, cat: "calendar-add", text: "schedule a video call with my brother on saturday at 11", must: [/EVENT .*brother.* 2026-10-17T11:00/i], want: "Sat 17 Oct 11:00." },
  { id: "Y12", split: T, cat: "calendar-add", text: "add swimming tomorrow at 7:30am", must: [/EVENT .*swimming.* 2026-10-16T07:30/i], want: "Fri 16 Oct 07:30." },
  { id: "Y13", split: T, cat: "calendar-add", text: "add the boiler inspection from the landlord's email", must: [/20 Oct|2026-10-20/i, /09:00/], want: "Tue 20 Oct 09:00-12:00." },
  { id: "Y14", split: T, cat: "calendar-add", text: "put a meeting with the bank on the 26th at quarter past ten", must: [/EVENT .*bank.* 2026-10-26T10:15/i], want: "Mon 26 Oct 10:15." },
  // reminders
  { id: "Y15", split: T, cat: "reminder", text: "remind me tonight to charge my phone", reminders: { count: 1, due: "2026-10-15 20:00", text: /phone/i }, want: "Tonight 20:00." },
  { id: "Y16", split: T, cat: "reminder", text: "remind me at 2 to send the slides", reminders: { count: 1, due: "2026-10-15 14:00", text: /slides/i }, want: "Today 14:00." },
  { id: "Y17", split: T, cat: "reminder", text: "remind me in 90 minutes to stretch my legs", reminders: { count: 1, due: "2026-10-15 12:0", text: /stretch/i }, want: "Today 12:00." },
  { id: "Y18", split: T, cat: "reminder", text: "remind me next tuesday to book the vet", reminders: { count: 1, due: "2026-10-20 09:00", text: /vet/i }, want: "Tue 20 Oct 09:00." },
  { id: "Y19", split: T, cat: "reminder", text: "remind me the night before the long run to lay out my kit", reminders: { count: 1, due: "2026-10-17 20:00", text: /kit/i }, want: "Sat 17 Oct 20:00." },
  { id: "Y20", split: T, cat: "reminder", text: "remind me friday at noon to call the plumber", reminders: { count: 1, due: "2026-10-16 12:00", text: /plumber/i }, want: "Fri 12:00." },
  { id: "Y21", split: T, cat: "reminder", text: "remind me to renew the passport", reminders: { count: 1, text: /passport/i }, want: "A reminder (no date)." },
  { id: "Y22", split: T, cat: "reminder", text: "list everything on my to-do list", must: [/no open reminders|no reminders/i], reminders: { count: 0 }, want: "None open." },
  // mail questions
  { id: "Y23", split: T, cat: "mail-question", text: "what does maria want me to bring", must: [/map/i], want: "The map." },
  { id: "Y24", split: T, cat: "mail-question", text: "when is the landlord sending someone for the boiler", must: [/Tue|20 Oct|\b20\b/i], want: "Next Tuesday 20 Oct." },
  { id: "Y25", split: T, cat: "mail-question", text: "is there news from my bank", must: [/statement/i], want: "The statement is ready." },
  { id: "Y26", split: T, cat: "mail-question", text: "what's the book club thing jordan mentioned", must: [/book club|November|book/i], want: "The November pick." },
  { id: "Y27", split: T, cat: "mail-question", text: "what's the price for renewing my car insurance", must: [/412/], want: "412 EUR." },
  { id: "Y28", split: T, cat: "mail-question", text: "did priya get back to me about the shelves", must: [/not yet|still waiting|\bno\b|hasn'?t/i], want: "Not yet." },
  { id: "Y29", split: T, cat: "mail-question", text: "what time does maria want to set off", must: [/\b8\b|08:00|8 ?am/i], want: "8am." },
  { id: "Y30", split: T, cat: "mail-question", text: "which emails are waiting for my answer", must: [/Maria|landlord|boiler|hike/i], want: "Maria's hike, the landlord." },
  // mail actions
  { id: "Y31", split: T, cat: "mail-action", text: "reply to maria that I'll be there at 8", must: [/reply to .*maria/i], want: "A draft to Maria." },
  { id: "Y32", split: T, cat: "mail-action", text: "tell the landlord 9 to 12 works for me", must: [/reply to .*landlord/i], want: "A draft to the landlord." },
  { id: "Y33", split: T, cat: "mail-action", text: "send a polite chaser to priya", must: [/Priya/], actions: 1, want: "One follow-up to Priya." },
  { id: "Y34", split: T, cat: "mail-action", text: "follow up with all the people I'm waiting on", actions: 2, want: "Two follow-ups." },
  { id: "Y35", split: T, cat: "mail-action", text: "answer jordan that I'll pick next time", must: [/reply to .*jordan/i], want: "A draft to Jordan." },
  { id: "Y36", split: T, cat: "mail-action", text: "nudge tom about those photos", must: [/Tom/], actions: 1, want: "One follow-up to Tom." },
  // notes
  { id: "Y37", split: T, cat: "notes", text: "how much is the kitchen ceiling", must: [/8,?000/], want: "8,000 EUR." },
  { id: "Y38", split: T, cat: "notes", text: "which kitchen quote moves the sink", must: [/\bB\b/], want: "Quote B." },
  { id: "Y39", split: T, cat: "notes", text: "how long is my longest long run going to be", must: [/19/], want: "19 km." },
  { id: "Y40", split: T, cat: "notes", text: "what are my lisbon plans", must: [/Alfama|tram|Belém|Belem|Sintra|fado/i], want: "Alfama guesthouse, tram 28, Belém, Sintra, fado." },
  { id: "Y41", split: T, cat: "notes", text: "what's on the tax checklist", must: [/payslip|salary|receipt/i], want: "Payslips, salary statement, donation receipts." },
  // the web
  { id: "Y42", split: T, cat: "web", text: "how many sides does a hexagon have", must: [/\b6\b|six/i], want: "Six." },
  { id: "Y43", split: T, cat: "web", text: "who painted the starry night", must: [/Van Gogh/i], want: "Van Gogh." },
  { id: "Y44", split: T, cat: "web", text: "what's the capital of japan", must: [/Tokyo/i], want: "Tokyo." },
  // trips
  { id: "Y45", split: T, cat: "trips", text: "what's my next trip", must: [/Lisbon|LIS/i], want: "Lisbon, Sat 7 Nov." },
  { id: "Y46", split: T, cat: "trips", text: "what time is the flight on the 7th", must: [/07:40|7:40/], want: "07:40." },
  { id: "Y47", split: T, cat: "trips", text: "where am I staying when I go to lisbon", must: [/Alfama/i], want: "Alfama." },
  // two requests in one
  { id: "Y48", split: T, cat: "two-asks", text: "where's lunch today and remind me at 12 to leave", must: [/Lumen/i], reminders: { count: 1, due: "2026-10-15 12:00", text: /leave/i }, want: "Café Lumen; a reminder 12:00." },
  { id: "Y49", split: T, cat: "two-asks", text: "did priya reply and if she didn't nudge her", must: [/Priya/i], actions: 1, want: "Not yet; one follow-up to Priya." },
  { id: "Y50", split: T, cat: "two-asks", text: "what does quote A cost and how long would it take", must: [/6,?900/, /6 weeks|six weeks/i], want: "6,900 EUR; six weeks." },
  { id: "Y51", split: T, cat: "two-asks", text: "add a run on saturday at 8am and remind me friday evening to charge my watch", must: [/EVENT .*run.* 2026-10-17T08:00/i], reminders: { count: 1, due: "2026-10-16 18:00", text: /watch/i }, want: "Run Sat 08:00; a reminder Fri 18:00." },
  { id: "Y52", split: T, cat: "two-asks", text: "when do I fly to lisbon and how many nights is the stay", must: [/07:40|7:40|7 Nov|Sat/i, /\b2\b|two/i], want: "Sat 7 Nov 07:40; two nights." },
  { id: "Y53", split: T, cat: "two-asks", text: "what's on friday and remind me thursday night to pack my bag", must: [/Spokes|bike|Spanish/i], reminders: { count: 1, due: "2026-10-15 20:00", text: /bag/i }, want: "Friday's events; a reminder tonight 20:00." },
  { id: "Y54", split: T, cat: "two-asks", text: "what did maria write and tell her I'm in", must: [/hike/i, /reply to .*maria/i], want: "The hike; a draft to Maria." },
  { id: "Y55", split: T, cat: "two-asks", text: "who still owes me an answer and chase the oldest one", must: [/Priya/i], actions: 1, want: "Priya and Tom; one follow-up to Priya." },
  // things the app can't do
  { id: "Y56", split: T, cat: "vague-unsupported", text: "order a pizza for tonight", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  { id: "Y57", split: T, cat: "vague-unsupported", text: "send 20 euros to tom", must: [/can't|cannot|not able|unable|don't|never/i], actions: "none", want: "Says it never moves money." },
  { id: "Y58", split: T, cat: "vague-unsupported", text: "turn off the kitchen lights", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  // summaries
  { id: "Y59", split: T, cat: "summary", text: "give me the rundown for today", must: [/Lunch|committee/i], want: "Today's lunch and committee." },
  { id: "Y60", split: T, cat: "summary", text: "what should I handle first in my inbox", must: [/Maria|landlord|boiler|hike/i], want: "Maria's hike or the landlord's slot." },
];
