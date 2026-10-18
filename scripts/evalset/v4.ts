import type { EvalItem } from "./types";

/**
 * Evaluation set v4 (written 2026-10-18 morning, before any run): a FRESH held-out test set. v3's failures were studied
 * and fixed (2132c69), so v3 is tuning material; v4 is the honest measure of those fixes. NEVER tune on v4. Same fictional
 * world and clock as v1 (see the facts in v1.ts): Thu 15 Oct 2026, 10:30 Madrid. No text shared with v1-v3 or the example
 * library.
 */
const T = "test" as const;

export const EVALSET_V4: EvalItem[] = [
  // calendar questions
  { id: "W01", split: T, cat: "calendar-question", text: "is there anything this evening", must: [/committee/i], never: [/Dentist/], want: "The committee at 18:00." },
  { id: "W02", split: T, cat: "calendar-question", text: "which cafe is lunch at", must: [/Lumen/i], want: "Café Lumen." },
  { id: "W03", split: T, cat: "calendar-question", text: "where does the garden committee meet", must: [/Library meeting room/i], want: "The library meeting room." },
  { id: "W04", split: T, cat: "calendar-question", text: "what time do I need to be at the bike shop", must: [/08:15|8:15/], want: "08:15 tomorrow." },
  { id: "W05", split: T, cat: "calendar-question", text: "how long is sunday's run", must: [/16 ?km|1 h 40|1h40|100 min|08:00.09:40|09:40/i], want: "16 km, 08:00–09:40." },
  { id: "W06", split: T, cat: "calendar-question", text: "what do I have on friday evening", must: [/Spanish/i], never: [/committee/i], want: "The Spanish exchange 19:00." },
  { id: "W07", split: T, cat: "calendar-question", text: "am I free on tuesday", must: [/free|nothing|no events/i], never: [/committee|Spanish|Lunch/i], want: "Nothing on the calendar (the boiler inspection is only in the mail)." },
  { id: "W08", split: T, cat: "calendar-question", text: "when's lunch with sam", must: [/12:30/], want: "Today 12:30." },
  // adding to the calendar
  { id: "W09", split: T, cat: "calendar-add", text: "add a call with mum on sunday at 6pm", must: [/EVENT .*mum.* 2026-10-18T18:00/i], want: "Call with mum Sun 18 Oct 18:00." },
  { id: "W10", split: T, cat: "calendar-add", text: "put the parents evening on the 22nd at 7pm", must: [/EVENT .*parents evening.* 2026-10-22T19:00/i], want: "Parents evening Thu 22 Oct 19:00." },
  { id: "W11", split: T, cat: "calendar-add", text: "schedule a run with Iker on saturday at 9am", must: [/EVENT .*Iker.* 2026-10-17T09:00/i], want: "Run with Iker Sat 17 Oct 09:00." },
  { id: "W12", split: T, cat: "calendar-add", text: "add an eye test next monday at 10:15", must: [/EVENT .*eye test.* 2026-10-19T10:15/i], want: "Eye test Mon 19 Oct 10:15." },
  { id: "W13", split: T, cat: "calendar-add", text: "put the landlord's boiler visit in my calendar", must: [/20 Oct|2026-10-20/i, /09:00/], want: "From the landlord's mail: Tue 20 Oct 09:00–12:00." },
  { id: "W14", split: T, cat: "calendar-add", text: "book in a dentist cleaning for december 2 at 4pm", must: [/EVENT .*dentist.* 2026-12-02T16:00/i], want: "Dentist cleaning Wed 2 Dec 16:00." },
  // reminders
  { id: "W15", split: T, cat: "reminder", text: "remind me on saturday morning to buy bread", reminders: { count: 1, due: "2026-10-17 09:00", text: /bread/i }, want: "Sat 17 Oct 09:00." },
  { id: "W16", split: T, cat: "reminder", text: "remind me at 4 to pick up the parcel", reminders: { count: 1, due: "2026-10-15 16:00", text: /parcel/i }, want: "Today 16:00." },
  { id: "W17", split: T, cat: "reminder", text: "remind me in 3 hours to call the bank", reminders: { count: 1, due: "2026-10-15 13:3", text: /bank/i }, want: "Today 13:30." },
  { id: "W18", split: T, cat: "reminder", text: "remind me on the 30th to pay the window cleaner", reminders: { count: 1, due: "2026-10-30 09:00", text: /window cleaner/i }, want: "Fri 30 Oct 09:00." },
  { id: "W19", split: T, cat: "reminder", text: "remind me the evening before the bike drop-off to pump the tyres", reminders: { count: 1, due: "2026-10-15 2", text: /tyres/i }, want: "Tonight (the evening before Fri 08:15)." },
  { id: "W20", split: T, cat: "reminder", text: "remind me tomorrow at 7 to stretch", reminders: { count: 1, due: "2026-10-16 07:00", text: /stretch/i }, want: "Fri 07:00." },
  { id: "W21", split: T, cat: "reminder", text: "don't let me forget to send the rent on monday", reminders: { count: 1, due: "2026-10-19 09:00", text: /rent/i }, want: "Mon 19 Oct 09:00." },
  { id: "W22", split: T, cat: "reminder", text: "do I have any reminders", must: [/no open reminders|no reminders/i], reminders: { count: 0 }, want: "None open (the world starts empty)." },
  // mail questions
  { id: "W23", split: T, cat: "mail-question", text: "what should I bring on the hike", must: [/map/i], want: "The map." },
  { id: "W24", split: T, cat: "mail-question", text: "what time window did the landlord give for the boiler", must: [/9.{0,6}12|9 ?am.{0,10}12|09:00.{0,6}12:00/i], want: "9–12." },
  { id: "W25", split: T, cat: "mail-question", text: "what did the bank email about", must: [/statement/i], want: "The statement is ready." },
  { id: "W26", split: T, cat: "mail-question", text: "is jordan's book club in november", must: [/yes|november/i], want: "Yes, the November pick." },
  { id: "W27", split: T, cat: "mail-question", text: "who is my car insurance with", must: [/Northgate/i], want: "Northgate." },
  { id: "W28", split: T, cat: "mail-question", text: "is priya's kitchen quote in yet", must: [/not yet|still waiting|\bno\b|hasn'?t/i], want: "Not yet; waiting 6 days." },
  { id: "W29", split: T, cat: "mail-question", text: "which route is maria planning", must: [/ridge/i], want: "The ridge loop." },
  { id: "W30", split: T, cat: "mail-question", text: "what came in from the landlord", must: [/boiler|inspection/i], want: "The boiler inspection next Tuesday." },
  // mail actions
  { id: "W31", split: T, cat: "mail-action", text: "answer maria that I can't make it saturday", must: [/reply to .*maria/i], want: "A draft to Maria." },
  { id: "W32", split: T, cat: "mail-action", text: "write back to the landlord confirming tuesday morning", must: [/reply to .*landlord/i], want: "A draft to the landlord." },
  { id: "W33", split: T, cat: "mail-action", text: "could you chase priya for me", must: [/Priya/], actions: 1, want: "One follow-up to Priya." },
  { id: "W34", split: T, cat: "mail-action", text: "send follow-ups to everyone who owes me an answer", actions: 2, want: "Two follow-ups (Priya, Tom)." },
  { id: "W35", split: T, cat: "mail-action", text: "reply to jordan saying both books sound good", must: [/reply to .*jordan/i], want: "A draft to Jordan." },
  { id: "W36", split: T, cat: "mail-action", text: "ping tom again about the pictures", must: [/Tom/], actions: 1, want: "One follow-up to Tom." },
  // notes
  { id: "W37", split: T, cat: "notes", text: "how much is quote B", must: [/7,?600/], want: "7,600 EUR." },
  { id: "W38", split: T, cat: "notes", text: "what does quote A include", must: [/oak/i], want: "Solid oak cabinet fronts." },
  { id: "W39", split: T, cat: "notes", text: "what was agreed about compost at the garden committee", must: [/rota/i], want: "A compost rota." },
  { id: "W40", split: T, cat: "notes", text: "where am I staying in lisbon according to my notes", must: [/Alfama|guesthouse/i], want: "A guesthouse in Alfama." },
  { id: "W41", split: T, cat: "notes", text: "how many days is my spanish streak", must: [/120/], want: "120 days." },
  // the web
  { id: "W42", split: T, cat: "web", text: "how many players are on a football team", must: [/\b11\b|eleven/i], want: "Eleven." },
  { id: "W43", split: T, cat: "web", text: "who composed the four seasons", must: [/Vivaldi/i], want: "Vivaldi." },
  { id: "W44", split: T, cat: "web", text: "what's the freezing point of water in fahrenheit", must: [/\b32\b/], want: "32 °F." },
  // trips
  { id: "W45", split: T, cat: "trips", text: "do I have any trips booked", must: [/Lisbon|LIS/i], want: "Lisbon, Sat 7 Nov." },
  { id: "W46", split: T, cat: "trips", text: "what's my flight number or airline to lisbon", must: [/Example Air/i], want: "Example Air." },
  { id: "W47", split: T, cat: "trips", text: "how many nights is the alfama booking", must: [/\b2\b|two/i], want: "Two nights." },
  // two requests in one
  { id: "W48", split: T, cat: "two-asks", text: "when is the committee and remind me an hour before to print the minutes", must: [/18:00/], reminders: { count: 1, due: "2026-10-15 17:00", text: /print|minutes/i }, want: "18:00; a reminder 17:00." },
  { id: "W49", split: T, cat: "two-asks", text: "where's the spanish exchange and remind me tomorrow at 6pm to leave", must: [/Library/i], reminders: { count: 1, due: "2026-10-16 18:00", text: /leave/i }, want: "Library café; a reminder Fri 18:00." },
  { id: "W50", split: T, cat: "two-asks", text: "how much is quote A and how long does it take", must: [/6,?900/, /6 weeks|six weeks/i], want: "6,900 EUR; six weeks." },
  { id: "W51", split: T, cat: "two-asks", text: "add yoga on wednesday at 7pm and remind me tuesday to wash my mat", must: [/EVENT .*yoga.* 2026-10-21T19:00/i], reminders: { count: 1, due: "2026-10-20 09:00", text: /mat/i }, want: "Yoga Wed 21 Oct 19:00; a reminder Tue 20 Oct." },
  { id: "W52", split: T, cat: "two-asks", text: "has priya replied and if not nudge her", must: [/Priya/i], actions: 1, want: "Not yet; one follow-up to Priya." },
  { id: "W53", split: T, cat: "two-asks", text: "what's tomorrow looking like and remind me tonight to set an alarm", must: [/Spokes|bike|Spanish/i], reminders: { count: 1, due: "2026-10-15 20:00", text: /alarm/i }, want: "Friday's events; a reminder tonight 20:00." },
  { id: "W54", split: T, cat: "two-asks", text: "what airline am I on and when do I land", must: [/Example Air/i], want: "Example Air (landing time if known)." },
  { id: "W55", split: T, cat: "two-asks", text: "what's on sunday and remind me saturday night to charge my watch", must: [/long run|16 ?km/i], reminders: { count: 1, due: "2026-10-17 20:00", text: /watch/i }, want: "The long run; a reminder Sat 20:00." },
  // things the app can't do
  { id: "W56", split: T, cat: "vague-unsupported", text: "book me a table for two tonight", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't book; nothing prepared." },
  { id: "W57", split: T, cat: "vague-unsupported", text: "transfer 50 euros to maria", must: [/can't|cannot|not able|unable|don't|never/i], actions: "none", want: "Says it never moves money." },
  { id: "W58", split: T, cat: "vague-unsupported", text: "start the washing machine", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  // summaries
  { id: "W59", split: T, cat: "summary", text: "brief me on today", must: [/Lunch|committee/i], want: "Today's lunch and committee." },
  { id: "W60", split: T, cat: "summary", text: "anything urgent in my mail", must: [/Maria|landlord|boiler|hike/i], want: "Maria's hike and the landlord's boiler mail." },
];
