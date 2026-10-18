import type { EvalItem } from "./types";

/**
 * Evaluation set v3 (written 2026-10-17 evening, before any run): a FRESH held-out test set. v2 had been run four times
 * as a measure (its failures never studied), so v3 takes over as the honest measure. NEVER tune on v3. Same fictional
 * world and clock as v1 (see the facts in v1.ts): Thu 15 Oct 2026, 10:30 Madrid. New wordings, no text shared with v1/v2.
 */
const T = "test" as const;

export const EVALSET_V3: EvalItem[] = [
  // calendar questions
  { id: "V01", split: T, cat: "calendar-question", text: "what's happening after lunch today", must: [/committee/i], never: [/Dentist/], want: "The committee at 18:00." },
  { id: "V02", split: T, cat: "calendar-question", text: "where do I drop off my bike", must: [/Spokes|Canal Street/i], want: "Spokes & Co, Canal Street." },
  { id: "V03", split: T, cat: "calendar-question", text: "what time is spanish tomorrow", must: [/19:00|7 ?pm/i], want: "19:00." },
  { id: "V04", split: T, cat: "calendar-question", text: "how long does the garden committee go on for", must: [/19:30|90 min|1h30|1\.5 hours|an hour and a half/i], want: "18:00–19:30, an hour and a half." },
  { id: "V05", split: T, cat: "calendar-question", text: "what's my first thing tomorrow", must: [/08:15|8:15|bike|Spokes/i], want: "The bike drop-off at 08:15." },
  { id: "V06", split: T, cat: "calendar-question", text: "where is the spanish exchange", must: [/Library caf/i], want: "The library café." },
  { id: "V07", split: T, cat: "calendar-question", text: "what's on next monday", must: [/\bno\b|nothing|free|no events|0 events/i], never: [/committee|Spanish|bike|Lunch/i], want: "Nothing on Mon 19 Oct." },
  { id: "V08", split: T, cat: "calendar-question", text: "when is the long run on sunday", must: [/08:00|8:00|8 ?am/i], want: "08:00." },
  // adding to the calendar
  { id: "V09", split: T, cat: "calendar-add", text: "put a haircut on tuesday at 6pm", must: [/EVENT .*haircut.* 2026-10-20T18:00/i], want: "Haircut Tue 20 Oct 18:00." },
  { id: "V10", split: T, cat: "calendar-add", text: "add coffee with Leo tomorrow at 9:30", must: [/EVENT .*Leo.* 2026-10-16T09:30/i], want: "Coffee with Leo Fri 16 Oct 09:30." },
  { id: "V11", split: T, cat: "calendar-add", text: "schedule a dentist checkup on november 3 at 10am", must: [/EVENT .*dentist.* 2026-11-03T10:00/i], want: "Dentist checkup Tue 3 Nov 10:00." },
  { id: "V12", split: T, cat: "calendar-add", text: "add piano lesson on the 29th at 5pm", must: [/EVENT .*piano.* 2026-10-29T17:00/i], want: "Piano lesson Thu 29 Oct 17:00." },
  { id: "V13", split: T, cat: "calendar-add", text: "save maria's hike in my calendar", must: [/17 Oct|2026-10-17|Sat/i, /08:00|8am|8:00/i], want: "From Maria's mail: Sat 17 Oct 08:00." },
  { id: "V14", split: T, cat: "calendar-add", text: "add a meeting with the tax advisor friday at 3pm", must: [/EVENT .*tax advisor.* 2026-10-16T15:00/i], want: "Tax advisor Fri 16 Oct 15:00." },
  // reminders
  { id: "V15", split: T, cat: "reminder", text: "remind me to call grandma on sunday", reminders: { count: 1, due: "2026-10-18 09:00", text: /grandma/i }, want: "Sun 18 Oct 09:00." },
  { id: "V16", split: T, cat: "reminder", text: "remind me tonight at 9 to lock the bike", reminders: { count: 1, due: "2026-10-15 21:00", text: /bike|lock/i }, want: "Today 21:00." },
  { id: "V17", split: T, cat: "reminder", text: "remind me in 30 minutes to take the laundry out", reminders: { count: 1, due: "2026-10-15 11:0", text: /laundry/i }, want: "Today 11:00." },
  { id: "V18", split: T, cat: "reminder", text: "set a reminder for the 1st of november to pay the gym", reminders: { count: 1, due: "2026-11-01 09:00", text: /gym/i }, want: "Sun 1 Nov 09:00." },
  { id: "V19", split: T, cat: "reminder", text: "remind me the day before the long run to get my gear ready", reminders: { count: 1, due: "2026-10-17", text: /gear/i }, want: "Sat 17 Oct." },
  { id: "V20", split: T, cat: "reminder", text: "remind me next friday to reserve the restaurant", reminders: { count: 1, due: "2026-10-23 09:00", text: /restaurant/i }, want: "Fri 23 Oct 09:00." },
  { id: "V21", split: T, cat: "reminder", text: "remind me thursday next week to call the garage", reminders: { count: 1, due: "2026-10-22 09:00", text: /garage/i }, want: "Thu 22 Oct 09:00." },
  { id: "V22", split: T, cat: "reminder", text: "show my to-do list", must: [/no open reminders|no reminders/i], reminders: { count: 0 }, want: "None open (the world starts empty)." },
  // mail questions
  { id: "V23", split: T, cat: "mail-question", text: "what did maria say about the hike", must: [/\b8\b|08:00|8 ?am|map|ridge/i], want: "Ridge loop, leaving 8am, bring the map." },
  { id: "V24", split: T, cat: "mail-question", text: "when is the boiler inspection", must: [/Tue|20 Oct|\b20\b/i], want: "Tue 20 Oct, 9–12." },
  { id: "V25", split: T, cat: "mail-question", text: "is my bank statement ready", must: [/ready|available/i], want: "Yes, the bank wrote it's ready." },
  { id: "V26", split: T, cat: "mail-question", text: "what did jordan email me about", must: [/book club|book/i], want: "The November book club pick." },
  { id: "V27", split: T, cat: "mail-question", text: "when does the car insurance renew", must: [/Dec/i], want: "1 Dec (mail) / 3 Dec (notes)." },
  { id: "V28", split: T, cat: "mail-question", text: "did tom ever get back to me about the photos", must: [/not yet|still waiting|\bno\b|hasn'?t/i], want: "Not yet; waiting 4 days." },
  { id: "V29", split: T, cat: "mail-question", text: "how much is the car insurance renewal", must: [/412/], want: "412 EUR." },
  { id: "V30", split: T, cat: "mail-question", text: "any important emails this morning", must: [/Maria|landlord|boiler|hike/i], want: "Maria's hike and the landlord's boiler mail." },
  // mail actions
  { id: "V31", split: T, cat: "mail-action", text: "reply to maria that I'll bring the map", must: [/reply to .*maria/i], want: "A draft to Maria." },
  { id: "V32", split: T, cat: "mail-action", text: "tell the landlord the morning slot works", must: [/reply to .*landlord/i], want: "A draft to the landlord." },
  { id: "V33", split: T, cat: "mail-action", text: "follow up with priya about the shelves quote", must: [/Priya/], actions: 1, want: "One follow-up to Priya." },
  { id: "V34", split: T, cat: "mail-action", text: "nudge everyone I'm waiting on", actions: 2, want: "Two follow-ups (Priya, Tom)." },
  { id: "V35", split: T, cat: "mail-action", text: "draft an answer to jordan picking the second book", must: [/reply to .*jordan/i], want: "A draft to Jordan." },
  { id: "V36", split: T, cat: "mail-action", text: "chase tom for the photos", must: [/Tom/], actions: 1, want: "One follow-up to Tom." },
  // notes
  { id: "V37", split: T, cat: "notes", text: "how much can I spend on the kitchen", must: [/8,?000/], want: "8,000 EUR including appliances." },
  { id: "V38", split: T, cat: "notes", text: "how long would quote A take", must: [/6 weeks|six weeks/i], want: "6 weeks." },
  { id: "V39", split: T, cat: "notes", text: "how long is my half marathon plan", must: [/ten weeks|10 weeks|ten-week|10-week/i], want: "Ten weeks." },
  { id: "V40", split: T, cat: "notes", text: "what's my spanish streak", must: [/120/], want: "120 days." },
  { id: "V41", split: T, cat: "notes", text: "which tram should I take in lisbon", must: [/\b28\b/], want: "Tram 28." },
  // the web
  { id: "V42", split: T, cat: "web", text: "what's the boiling point of water in fahrenheit", must: [/212/], want: "212 °F." },
  { id: "V43", split: T, cat: "web", text: "who invented the telephone", must: [/Bell/], want: "Alexander Graham Bell." },
  { id: "V44", split: T, cat: "web", text: "how many continents are there", must: [/\b7\b|seven/i], want: "Seven." },
  // trips
  { id: "V45", split: T, cat: "trips", text: "which neighbourhood am I staying in in lisbon", must: [/Alfama/i], want: "Alfama." },
  { id: "V46", split: T, cat: "trips", text: "what day do I fly to lisbon", must: [/Sat|7 Nov|Saturday/i], want: "Sat 7 Nov." },
  { id: "V47", split: T, cat: "trips", text: "which airport do I fly out of", must: [/BCN|Barcelona/i], want: "Barcelona (BCN)." },
  // two requests in one
  { id: "V48", split: T, cat: "two-asks", text: "where's lunch and remind me at 3 to call the bank", must: [/Lumen/i], reminders: { count: 1, due: "2026-10-15 15:00", text: /bank/i }, want: "Café Lumen; a reminder 15:00." },
  { id: "V49", split: T, cat: "two-asks", text: "has tom replied and remind me tomorrow to chase him", must: [/Tom/i], reminders: { count: 1, due: "2026-10-16 09:00" }, want: "Not yet; a reminder Fri 09:00." },
  { id: "V50", split: T, cat: "two-asks", text: "what time is spanish tomorrow and where is it", must: [/19:00|7 ?pm/i, /Library/i], want: "19:00 at the library café." },
  { id: "V51", split: T, cat: "two-asks", text: "add coffee with Ana on tuesday at 10 and remind me monday to bring the book", must: [/EVENT .*Ana.* 2026-10-20T10:00/i], reminders: { count: 1, due: "2026-10-19 09:00", text: /book/i }, want: "Coffee Tue 20 Oct 10:00; a reminder Mon 19 Oct." },
  { id: "V52", split: T, cat: "two-asks", text: "what's the kitchen budget and how long does quote B take", must: [/8,?000/, /4 weeks|four weeks/i], want: "8,000 EUR; 4 weeks." },
  { id: "V53", split: T, cat: "two-asks", text: "who hasn't replied yet and nudge priya", must: [/Priya|Tom/i], actions: 1, want: "Priya and Tom; one follow-up to Priya." },
  { id: "V54", split: T, cat: "two-asks", text: "when's my flight and how many nights am I staying", must: [/07:40|7:40/, /\b2\b|two/i], want: "07:40 Sat 7 Nov; two nights." },
  { id: "V55", split: T, cat: "two-asks", text: "what's on saturday and remind me friday to buy snacks", reminders: { count: 1, due: "2026-10-16 09:00", text: /snacks/i }, want: "Saturday's calendar; a reminder Fri 09:00." },
  // things the app can't do
  { id: "V56", split: T, cat: "vague-unsupported", text: "order flowers for my mum", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't; nothing prepared." },
  { id: "V57", split: T, cat: "vague-unsupported", text: "pay my electricity bill", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  { id: "V58", split: T, cat: "vague-unsupported", text: "dim the living room lights", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  // summaries
  { id: "V59", split: T, cat: "summary", text: "give me a quick overview of my day", must: [/Lunch|committee/i], want: "Today's lunch and committee." },
  { id: "V60", split: T, cat: "summary", text: "what's important in my inbox", must: [/Maria|landlord|boiler|hike/i], want: "Maria's hike and the landlord's boiler mail." },
];
