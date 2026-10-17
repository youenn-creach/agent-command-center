import type { Expected } from "./sim-batch3";

/**
 * Simulation batch 5: a second TUNING batch (batch 3 is saturated; batch 4 stays held-out). 24 new complex requests with
 * different shapes: typos, lowercase, terse phrasing, follow-ups with names, dates in several formats, mixed asks.
 * Expected outcomes written on 2026-10-15 BEFORE the first run. Same environment and facts as batch 4 (see sim-batch4.ts),
 * same judging rule (an ERROR is anything that differs from what the user would want).
 */
export const BATCH5: Expected[] = [
  { text: "whats on thurs and fri this week", want: "Today (Thu 15 Oct): dentist 09:30, lunch with Sam 12:30, committee 18:00; and tomorrow (Fri 16): bike drop-off 08:15, Spanish exchange 19:00. Both days, nothing invented.", must: [/dentist/i, /spanish/i] },
  { text: "remind me tmrw morning to call Priya and chase the shelves quote", want: "A reminder tomorrow (Fri 16 Oct) at 09:00 about calling Priya, AND a follow-up prepared for Priya about the shelves quote.", must: [/priya/i] },
  { text: "can u tell the landlord thursday is fine for the boiler", want: "A reply draft to the landlord. The boiler inspection is next Tuesday (20 Oct): a draft that says Thursday is fine is what was asked; the app must not change the date or invent facts; it writes what the user said.", must: [/landlord/i] },
  { text: "how much is left of the kitchen budget if I go with quote B", want: "8,000 minus 7,600 = 400 EUR left (the budget cap includes appliances). From the note, nothing invented.", must: [/400/] },
  { text: "list what I have to do this weekend", want: "Saturday: the hike with Maria is in the mail (8am, bring the map); Sunday: the 16 km long run at 08:00. No invented items.", must: [/hike|maria/i, /long run|16/i] },
  { text: "add yoga every tuesday at 7pm to my calendar", want: "Cannot create recurring events or says it adds one event; must not claim a recurring series was created. If it adds one event it is on Tue 20 Oct 19:00 and says it is a single event.", never: [/every tuesday.*(created|added|set up)/i] },
  { text: "what's priya's email", want: "Priya Shah's address as it appears in the mail (priya@example.com) if known from the tracked wait, or says it cannot find it. No invented address.", must: [/priya/i] },
  { text: "tell me the headlines and what the weather's like", want: "News headlines (web/RSS if available, or says it needs the briefing/news feed) AND the weather answer (the app has no home city set: says so). Nothing invented.", must: [/./] },
  { text: "reminder: pay rent on the 1st", want: "ONE reminder 'pay rent' due on the next 1st: Sun 1 Nov 2026 (09:00).", must: [/rent/i, /1 nov|2026-11-01/i] },
  { text: "did the bank send anything this week", want: "Yes: the monthly statement is ready (the bank mail from about a day ago). It needs no action.", must: [/statement/i] },
  { text: "when did Maria write and what did she ask", want: "Maria wrote about 2 hours ago (today) asking about the Saturday hike (leaving 8am, ridge loop) and to bring the map.", must: [/hike/i, /map/i] },
  { text: "put a reminder on friday at 5pm to water the plants and another on saturday morning to buy bread", want: "TWO reminders: Fri 16 Oct 17:00 (water the plants) and Sat 17 Oct morning, 09:00 (buy bread).", must: [/plants/i, /bread/i] },
  { text: "is there a spanish thing coming up", want: "The Spanish conversation exchange tomorrow, Fri 16 Oct, 19:00 at the library café.", must: [/spanish/i, /19:00|7 ?pm/i] },
  { text: "forward the boiler email to Tom", want: "Cannot forward email (it only writes replies as drafts). Says so, offers an alternative; nothing sent or prepared as a forward.", never: [/\bforwarded\b/i] },
  { text: "what's my schedule next monday", want: "Mon 19 Oct: nothing in the calendar (nothing seeded). Says it is free; may note that it is the day before the boiler inspection only if from mail. No invented events.", must: [/./] },
  { text: "summarize the maria thread", want: "Maria's hike mail summarised: Saturday hike, ridge loop, leaving 8am, bring the map.", must: [/hike|ridge/i] },
  { text: "do i have to pay anything soon", want: "From the mail: the car insurance renewal 1 Dec 2026 (412 EUR) is the only money item; the bank statement is not a bill. No invented bills.", must: [/insurance|renew/i] },
  { text: "chase priya then add a reminder for monday to check", want: "A follow-up prepared for Priya AND a reminder for Mon 19 Oct (09:00) to check.", must: [/priya/i, /19 oct|2026-10-19|mon/i] },
  { text: "give me a quick rundown of tomorrow and anything I should prep", want: "Tomorrow's two events (bike drop-off, Spanish exchange) and short prep hints without inventing facts.", must: [/bike|spokes/i, /spanish/i] },
  { text: "how long have i been waiting on tom", want: "4 days (photos from the trip).", must: [/4 days/i] },
  { text: "ok and what about wednesday", want: "A follow-up with no context: either asks what the user means or answers for Wednesday 21 Oct (calendar empty). Never fabricates a previous question.", never: [/as I said|earlier you asked/i] },
  { text: "buy me flowers for maria", want: "Cannot buy things; says so. Nothing prepared.", never: [/\b(bought|ordered)\b/i], proposes: "none" },
  { text: "show me what's waiting for my approval", want: "Lists what waits in the approval queue (possibly nothing in a fresh folder) without inventing items.", must: [/./] },
  { text: "find any mail about my race registration and add the date to my calendar", want: "No race-registration mail exists in the demo mailbox: says none was found and adds nothing. Must not invent a race.", never: [/Here is the event/i], proposes: "none" },
];
