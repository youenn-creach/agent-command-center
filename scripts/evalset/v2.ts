import type { EvalItem } from "./types";

/**
 * Evaluation set v2 (written 2026-10-16, before any run): a FRESH held-out test set. v1's test items had been used to
 * measure several rounds; once their failures are studied they become tuning material, so v2 takes over as the honest
 * measure. NEVER tune on v2. Same fictional world and clock as v1 (see the facts in v1.ts): Thu 15 Oct 2026, 10:30 Madrid.
 */
const T = "test" as const;

export const EVALSET_V2: EvalItem[] = [
  // calendar questions
  { id: "U01", split: T, cat: "calendar-question", text: "do I have plans this evening", must: [/committee/i], never: [/Dentist/], want: "The committee at 18:00." },
  { id: "U02", split: T, cat: "calendar-question", text: "where's lunch today", must: [/Lumen/i], want: "Café Lumen." },
  { id: "U03", split: T, cat: "calendar-question", text: "what am I doing tomorrow night", must: [/Spanish/i], never: [/committee/i], want: "Spanish conversation exchange 19:00." },
  { id: "U04", split: T, cat: "calendar-question", text: "how early do I have to be up on friday", must: [/08:15|8:15/], want: "The bike drop-off at 08:15." },
  { id: "U05", split: T, cat: "calendar-question", text: "is sunday morning free", must: [/long run|08:00|8:00/i], want: "No: the long run 08:00–09:40." },
  { id: "U06", split: T, cat: "calendar-question", text: "what time does the committee finish", must: [/19:30/], want: "19:30." },
  { id: "U07", split: T, cat: "calendar-question", text: "who am I having lunch with", must: [/Sam/], want: "Sam." },
  { id: "U08", split: T, cat: "calendar-question", text: "anything on the calendar next wednesday", must: [/\bno\b|nothing|free|no events|0 events/i], never: [/committee|Spanish|bike|Lunch/i], want: "Nothing on Wed 21 Oct." },
  // adding to the calendar
  { id: "U09", split: T, cat: "calendar-add", text: "put a call with the bank on monday at 11", must: [/EVENT .*bank.* 2026-10-19T11:00/i], want: "Call with the bank Mon 19 Oct 11:00." },
  { id: "U10", split: T, cat: "calendar-add", text: "add drinks with Nadia friday at 7pm", must: [/EVENT .*Nadia.* 2026-10-16T19:00/i], want: "Drinks with Nadia Fri 16 Oct 19:00." },
  { id: "U11", split: T, cat: "calendar-add", text: "schedule the car service for the 27th at 8:30", must: [/EVENT .*car service.* 2026-10-27T08:30/i], want: "Car service Tue 27 Oct 08:30." },
  { id: "U12", split: T, cat: "calendar-add", text: "can you add a team lunch next thursday at 1pm", must: [/EVENT .*team lunch.* 2026-10-22T13:00/i], want: "Team lunch Thu 22 Oct 13:00." },
  { id: "U13", split: T, cat: "calendar-add", text: "put the hike on saturday in my calendar", must: [/17 Oct|2026-10-17|Sat/i, /08:00|8am|8:00/i], want: "From Maria's mail: Sat 17 Oct 08:00." },
  { id: "U14", split: T, cat: "calendar-add", text: "add a vet appointment on wednesday at 4pm", must: [/EVENT .*vet.* 2026-10-21T16:00/i], want: "Vet Wed 21 Oct 16:00." },
  // reminders
  { id: "U15", split: T, cat: "reminder", text: "remind me tomorrow morning to buy stamps", reminders: { count: 1, due: "2026-10-16 09:00", text: /stamps/i }, want: "Fri 09:00." },
  { id: "U16", split: T, cat: "reminder", text: "remind me at 5 to call the vet", reminders: { count: 1, due: "2026-10-15 17:00", text: /vet/i }, want: "Today 17:00." },
  { id: "U17", split: T, cat: "reminder", text: "in an hour remind me to move the car", reminders: { count: 1, due: "2026-10-15 11:3", text: /car/i }, want: "Today 11:30." },
  { id: "U18", split: T, cat: "reminder", text: "set a reminder for monday to send the invoice", reminders: { count: 1, due: "2026-10-19 09:00", text: /invoice/i }, want: "Mon 19 Oct 09:00." },
  { id: "U19", split: T, cat: "reminder", text: "remind me the evening before my flight to pack", reminders: { count: 1, due: "2026-11-06", text: /pack/i }, want: "Fri 6 Nov, evening." },
  { id: "U20", split: T, cat: "reminder", text: "don't let me forget to water the tomatoes on saturday", reminders: { count: 1, due: "2026-10-17 09:00", text: /tomatoes/i }, want: "Sat 17 Oct 09:00." },
  { id: "U21", split: T, cat: "reminder", text: "remind me before the committee to print the agenda", reminders: { count: 1, due: "2026-10-15 1", text: /print|agenda/i }, want: "Today, before 18:00." },
  { id: "U22", split: T, cat: "reminder", text: "what reminders do I have", must: [/no open reminders|no reminders/i], reminders: { count: 0 }, want: "None open (the world starts empty)." },
  // mail questions
  { id: "U23", split: T, cat: "mail-question", text: "did the bank write about anything important", must: [/statement/i], want: "Only that the statement is ready." },
  { id: "U24", split: T, cat: "mail-question", text: "what's the boiler email about", must: [/inspection/i, /Tue|20/i], want: "The inspection next Tuesday 20 Oct, 9–12." },
  { id: "U25", split: T, cat: "mail-question", text: "what time is the hike leaving", must: [/\b8\b|08:00|8 ?am/i], want: "8am." },
  { id: "U26", split: T, cat: "mail-question", text: "which books did jordan suggest", must: [/book club|title/i], want: "The two titles for the November book club." },
  { id: "U27", split: T, cat: "mail-question", text: "how much does northgate want", must: [/412/], want: "412 EUR for the renewal." },
  { id: "U28", split: T, cat: "mail-question", text: "has priya sent the quote", must: [/not yet|still waiting|\bno\b/i], want: "Not yet; waiting 6 days." },
  { id: "U29", split: T, cat: "mail-question", text: "what did the landlord ask me", must: [/boiler|inspection/i], want: "To confirm the boiler inspection slot." },
  { id: "U30", split: T, cat: "mail-question", text: "when does my car insurance run out", must: [/1 Dec|December 1|1st of December|2026-12-01|1\/12/i], want: "1 Dec 2026 (the insurer's mail)." },
  // mail actions
  { id: "U31", split: T, cat: "mail-action", text: "reply to jordan that I vote for the first title", must: [/reply to .*jordan/i], want: "A draft to Jordan." },
  { id: "U32", split: T, cat: "mail-action", text: "let the landlord know tuesday is fine", must: [/reply to .*landlord/i], want: "A draft to the landlord." },
  { id: "U33", split: T, cat: "mail-action", text: "give tom a nudge about the photos", must: [/Tom/], actions: 1, want: "One follow-up to Tom." },
  { id: "U34", split: T, cat: "mail-action", text: "chase everyone who hasn't answered", actions: 2, want: "Two follow-ups (Priya, Tom)." },
  { id: "U35", split: T, cat: "mail-action", text: "write to maria saying count me in", must: [/reply to .*maria/i], want: "A draft to Maria." },
  { id: "U36", split: T, cat: "mail-action", text: "send priya a gentle reminder", must: [/Priya/], actions: 1, want: "One follow-up to Priya." },
  // notes
  { id: "U37", split: T, cat: "notes", text: "how far is my longest planned run", must: [/19/], want: "19 km." },
  { id: "U38", split: T, cat: "notes", text: "what's my half marathon target time", must: [/1h55|1:55|1 hour 55|one hour fifty-five|55 min/i], want: "Under 1h55." },
  { id: "U39", split: T, cat: "notes", text: "which kitchen quote is quicker", must: [/\bB\b|four weeks|4 weeks/i], want: "Quote B, 4 weeks." },
  { id: "U40", split: T, cat: "notes", text: "what do I need for my taxes", must: [/payslip|salary|receipt/i], want: "Payslips, salary statement, donation receipts." },
  { id: "U41", split: T, cat: "notes", text: "how often do I feed my sourdough", must: [/week/i], want: "Once a week." },
  // the web
  { id: "U42", split: T, cat: "web", text: "what's the capital of canada", must: [/Ottawa/i], want: "Ottawa." },
  { id: "U43", split: T, cat: "web", text: "who painted the mona lisa", must: [/Leonardo|da Vinci/i], want: "Leonardo da Vinci." },
  { id: "U44", split: T, cat: "web", text: "how many legs does a spider have", must: [/\b8\b|eight/i], want: "Eight." },
  // trips
  { id: "U45", split: T, cat: "trips", text: "what airline am I flying with", must: [/Example Air/i], want: "Example Air." },
  { id: "U46", split: T, cat: "trips", text: "how long is my lisbon stay", must: [/\b2\b|two/i], want: "Two nights." },
  { id: "U47", split: T, cat: "trips", text: "what time is my flight to lisbon", must: [/07:40|7:40/], want: "07:40 on Sat 7 Nov." },
  // two requests in one
  { id: "U48", split: T, cat: "two-asks", text: "what's on tomorrow and remind me to charge my bike lights tonight", must: [/Spokes|bike|Spanish/i], reminders: { count: 1, due: "2026-10-15 20:00", text: /lights/i }, want: "Friday's events, and a reminder tonight 20:00." },
  { id: "U49", split: T, cat: "two-asks", text: "check if priya answered and nudge tom", must: [/Priya/i], actions: 1, want: "Priya hasn't answered; one follow-up to Tom." },
  { id: "U50", split: T, cat: "two-asks", text: "when is my next long run and how long is it", must: [/Sun|18 Oct|Sunday/i, /16 ?km|09:40|1 ?h ?40/i], want: "Sun 18 Oct 08:00–09:40, 16 km." },
  { id: "U51", split: T, cat: "two-asks", text: "add the boiler inspection to my calendar and remind me the day before to clear the cupboard", must: [/20 Oct|2026-10-20/i], reminders: { count: 1, due: "2026-10-19", text: /cupboard/i }, want: "The inspection Tue 20 Oct, a reminder Mon 19 Oct." },
  { id: "U52", split: T, cat: "two-asks", text: "what's my flight time and remind me to check in the day before", must: [/07:40|7:40/], reminders: { count: 1, due: "2026-11-06", text: /check/i }, want: "07:40 Sat 7 Nov; a reminder Fri 6 Nov." },
  { id: "U53", split: T, cat: "two-asks", text: "who still owes me a reply and draft a follow-up to the oldest", must: [/Priya/i], actions: 1, want: "Priya and Tom; one follow-up to Priya (6 days)." },
  { id: "U54", split: T, cat: "two-asks", text: "what's the kitchen budget and which quote is cheaper", must: [/8,?000/, /\bA\b|6,?900/], want: "8,000 EUR; quote A (6,900)." },
  { id: "U55", split: T, cat: "two-asks", text: "is anything on saturday, and remind me friday night to pack the map", reminders: { count: 1, due: "2026-10-16 20:00", text: /map/i }, want: "Saturday's calendar; a reminder Fri 20:00." },
  // things the app can't do
  { id: "U56", split: T, cat: "vague-unsupported", text: "book a taxi to the airport", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't book; nothing prepared." },
  { id: "U57", split: T, cat: "vague-unsupported", text: "turn the heating up", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  { id: "U58", split: T, cat: "vague-unsupported", text: "play the news podcast", must: [/can't|cannot|not able|unable|don't/i], actions: "none", want: "Says it can't." },
  // summaries
  { id: "U59", split: T, cat: "summary", text: "what should I deal with first today", must: [/Maria|landlord|boiler|hike|committee|Lunch/i], want: "A priorities list from today's calendar and mail." },
  { id: "U60", split: T, cat: "summary", text: "give me a rundown of my day", must: [/Lunch|committee/i], want: "Today's events (and what needs attention)." },
];
