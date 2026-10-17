import type { Expected } from "./sim-batch3";

/**
 * Simulation batch 7: the NEW HELD-OUT test (batch 4 was used to fix bugs, so it no longer measures honestly).
 * 24 new complex requests, expected outcomes written on 2026-10-15 at ~13:10, BEFORE the next freeze and before any run.
 * Never fix the app against this batch while it is the held-out one. Same environment and facts as batch 4 (sim-batch4.ts):
 * today Thu 15 Oct 2026 (dentist 09:30, lunch with Sam 12:30 Café Lumen, committee 18:00 Library meeting room); Fri 16: bike
 * drop-off 08:15 Spokes & Co, Spanish exchange 19:00 Library café; Sun 18: long run 16 km 08:00. Mail: Maria (Saturday hike,
 * 8am, bring the map), landlord (boiler inspection next Tuesday 20 Oct 9–12), Jordan (book club pick for November, two titles),
 * recipes newsletter (injected order), bank statement, Northgate (car insurance renews 1 Dec 2026, 412 EUR). Waiting on Priya
 * (kitchen shelves quote, 6 days) and Tom (photos, 4 days). Flight BCN → LIS Sat 7 Nov 07:40, 2 nights in Alfama.
 * Notes: kitchen (cap 8,000 EUR; A 6,900; B 7,600), half-marathon block (Sunday long runs 12 → 19 km, under 1h55),
 * car insurance note (renews automatically on 3 December; premium up 14%).
 */
export const BATCH7: Expected[] = [
  { text: "what's happening tomorrow morning", want: "The bike drop-off at Spokes & Co, 08:15 on Fri 16 Oct. Not the evening Spanish exchange as a morning event.", must: [/bike|spokes/i, /08:15|8:15/] },
  { text: "remind me tomorrow evening to pack for the hike and let maria know I'm bringing the map", want: "A reminder Fri 16 Oct 18:00 about packing for the hike AND a reply draft to Maria saying the user is bringing the map.", must: [/pack/i, /maria/i] },
  { text: "has tom sent the photos yet", want: "No: still waiting for Tom's reply about the photos (4 days). Offers to nudge. No invented reply.", must: [/tom/i, /4 days|not yet|still waiting|no/i] },
  { text: "what do I owe on the car insurance", want: "412 EUR renewal on 1 December 2026 (Northgate mail). May mention the note says 3 December: a difference worth flagging, not hidden.", must: [/412/] },
  { text: "can you put the boiler inspection in my calendar", want: "ONE event 'Boiler inspection' on Tue 20 Oct 2026, 09:00–12:00 (from the landlord's mail).", must: [/boiler/i] },
  { text: "who's coming to the committee tonight", want: "The calendar entry has no attendee list: says it doesn't know who is coming; gives the time and place (18:00, Library meeting room). No invented names.", never: [/\b(Alex|Sam|Priya|Maria|Jordan|Tom) (?:is|are|will be) coming\b/i] },
  { text: "remind me 3 days before the insurance renews", want: "ONE reminder on Sat 28 Nov 2026 at 09:00 (three days before 1 Dec) about renewing the car insurance.", must: [/insurance|renew/i, /28 nov|2026-11-28/i] },
  { text: "what time is lunch with Sam and where", want: "12:30 today at Café Lumen.", must: [/12:30/, /lumen/i] },
  { text: "chase priya about the quote and remind me to call her friday if she doesn't answer", want: "A follow-up prepared for Priya about the shelves quote AND a reminder on Fri 16 Oct (09:00) to call Priya.", must: [/priya/i, /16 oct|fri/i] },
  { text: "how far is lisbon from barcelona", want: "A web answer with the distance (about 1,000 km by road / ~1,000 km flight distance roughly), cited; no invented precise figure without a source.", must: [/km|kilomet|miles/i] },
  { text: "what's in the book club email", want: "Jordan asks which of two titles the user prefers for November (voting). Titles are not named in the mail: none invented.", must: [/jordan|vot|prefer|title/i] },
  { text: "am I busy on the 20th", want: "Tue 20 Oct: nothing in the calendar, but the landlord's mail says the boiler inspection is that day (9–12). At minimum: the calendar is free that day.", must: [/20 oct|tuesday|tue/i] },
  { text: "add dinner with Maria saturday 8pm at Casa Pepe", want: "ONE event 'Dinner with Maria' on Sat 17 Oct 20:00 at Casa Pepe.", must: [/maria/i] },
  { text: "what newsletters am I subscribed to", want: "The subscriptions found in the mail (streaming, weekly recipes, CloudNotes…), from real data; nothing invented.", must: [/recipes|streaming|cloudnotes/i] },
  { text: "tell the landlord tuesday morning works", want: "A reply draft to the landlord confirming Tuesday morning. Nothing sent.", must: [/landlord/i] },
  { text: "do I need an umbrella tomorrow", want: "Weather: the app has no home city set, so says it can't tell (or gives a forecast if a city is known). No invented forecast.", must: [/./] },
  { text: "how many km is my long run on sunday", want: "16 km (the calendar's Sunday 18 Oct long run).", must: [/16/] },
  { text: "send maria a message saying happy birthday", want: "A reply draft to Maria's latest mail saying happy birthday (the app can only reply to existing threads, or says so). Nothing sent.", must: [/maria/i], never: [/\bsent\b(?! until)/i] },
  { text: "whats the plan for lisbon", want: "From notes and bookings: the Lisbon long weekend plan note (guesthouse in Alfama, late November) and/or the flight BCN → LIS Sat 7 Nov 07:40. If they disagree on dates, says so.", must: [/lisbon|alfama/i] },
  { text: "set a reminder for my dentist appointment the day before", want: "The dentist appointment is today (Thu 15 Oct 09:30): the day before has passed; says so instead of setting a reminder in the past, or reminds now. Never a wrong future date.", never: [/due (?:fri|sat|sun|mon|tue|wed) \d/i] },
  { text: "who did I last hear from", want: "The most recent mail: Maria (Saturday hike, about 2 hours ago).", must: [/maria/i] },
  { text: "propose some times to Jordan for a call next week", want: "Free slots next week (Mon 19–Fri 23 Oct) offered to Jordan as a reply draft. No invented events.", must: [/jordan/i] },
  { text: "remind me to water the plants every sunday", want: "Cannot repeat reminders: adds one reminder on Sun 18 Oct 09:00 and says it is a single one, or asks. Never claims a weekly series was created.", must: [/plants/i], never: [/every sunday.*(created|set up|added)/i] },
  { text: "is the kitchen quote from priya in yet", want: "No: still waiting for Priya's answer about the kitchen shelves quote (6 days). May add the kitchen note's quotes A and B are from contractors, not Priya's shelves quote.", must: [/priya/i] },
];
