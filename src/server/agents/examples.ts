import { stem } from "../retrieval/text";

/**
 * The example library (docs/ACCURACY_PLAN.md, phase B): requests met in the simulations, each labelled with the skill that
 * answers it. Before routing, the few most similar ones are shown to the local model as worked examples, so a fix carries
 * over to paraphrases instead of needing a wording rule. Single requests only (two-part requests go through the splitter).
 * NEVER add an item of the evaluation set (scripts/evalset): a test checks there is no overlap, or the measurements would lie.
 * The routing eval's requests (scripts/eval-cases.ts) are kept out too, so that eval still checks the router on its own.
 */
export const LIBRARY: [string, string][] = [
  // calendar questions
  ["do I have anything on friday evening", "agenda {}"],
  ["what is my week looking like", "agenda {}"],
  ["what time does the committee meeting start tonight and where is it", "agenda {}"],
  ["whats on thurs and fri this week", "agenda {}"],
  ["is there a spanish thing coming up", "agenda {}"],
  ["what's my schedule next monday", "agenda {}"],
  ["what am I doing saturday", "agenda {}"],
  ["do I have anything at the library this week", "agenda {}"],
  ["what's going on tonight", "agenda {}"],
  ["whats my next run", "agenda {}"],
  ["what's happening tomorrow morning", "agenda {}"],
  ["who's coming to the committee tonight", "agenda {}"],
  ["what time is lunch with Sam and where", "agenda {}"],
  ["am I busy on the 20th", "agenda {}"],
  ["what's left on my calendar today", "agenda {}"],
  ["do I have time for a coffee with Sam before the committee", "agenda {}"],
  ["anything on after lunch today", "agenda {}"],
  ["when's my next appointment", "agenda {}"],
  ["find me a free evening next week", "agenda {}"],
  // adding to the calendar
  ["add yoga every tuesday at 7pm to my calendar", "add_event {}"],
  ["schedule a call with Jordan friday 4pm", "add_event {}"],
  ["add dinner with Maria saturday 8pm at Casa Pepe", "add_event {}"],
  ["put dentist on the 3rd at 10am", "add_event {}"],
  ["put the long run in my calendar for next sunday too", "add_event {}"],
  ["find any mail about my race registration and add the date to my calendar", 'event_from_email {"query":"race registration"}'],
  ["can you put the boiler inspection in my calendar", 'event_from_email {"query":"boiler inspection"}'],
  ["add the hike with maria to my calendar", 'event_from_email {"query":"from:Maria hike"}'],
  // reminders
  ["remind me in 2 hours to take the laundry out", "reminder {}"],
  ["add a reminder for the 30th to book the car service", "reminder {}"],
  ["i need to bring the map on saturday, can you remind me friday night", "reminder {}"],
  ["set a reminder for my dentist appointment the day before", "reminder {}"],
  ["remind me tonight to reply to maria", "reminder {}"],
  ["remind me to buy a gift for maria before the hike", "reminder {}"],
  ["remind me about jordan's book club the day before", 'reminder_from_email {"query":"Jordan book club"}'],
  ["remind me 3 days before the insurance renews", 'reminder_from_email {"query":"insurance renewal"}'],
  // mail: what needs me
  ["go through my mail and tell me which ones I need to answer", 'inbox_review {"days":7}'],
  ["is there anything I forgot to answer", 'inbox_review {"days":14}'],
  ["do i have to pay anything soon", 'inbox_review {"days":30}'],
  // mail: find or answer from it
  ["did the bank send anything this week", 'email_search {"query":"from:bank","days":7}'],
  ["summarise the weekly recipes email", 'email_question {"query":"recipes"}'],
  ["what's the recipe newsletter about this week", 'email_question {"query":"recipes newsletter"}'],
  ["when's the boiler guy coming", 'email_question {"query":"boiler"}'],
  ["how much does my car insurance renewal cost and when", 'email_question {"query":"car insurance renewal"}'],
  ["has tom sent the photos yet", 'email_question {"query":"from:Tom photos"}'],
  ["what do I owe on the car insurance", 'email_question {"query":"car insurance"}'],
  ["summarize the maria thread", 'email_question {"query":"from:Maria"}'],
  ["what did maria want", 'email_question {"query":"from:Maria"}'],
  ["do I need to do anything about the bank email", 'email_question {"query":"from:bank"}'],
  ["is the kitchen quote from priya in yet", 'email_question {"query":"from:Priya quote"}'],
  // writing to people
  ["reply to Maria that I'll bring snacks too", 'draft_reply {"who":"Maria","message":"I\'ll bring snacks too"}'],
  ["can u tell the landlord thursday is fine for the boiler", 'draft_reply {"who":"landlord","message":"Thursday is fine for the boiler"}'],
  ["let maria know I can't make it saturday", 'draft_reply {"who":"Maria","message":"I can\'t make it Saturday"}'],
  ["what should I reply to the landlord", 'draft_reply {"who":"landlord"}'],
  ["send maria a message saying happy birthday", 'draft_reply {"who":"Maria","message":"happy birthday"}'],
  ["tell maria I'm in for saturday and ask what time we meet", 'draft_reply {"who":"Maria","message":"I\'m in for Saturday, what time do we meet?"}'],
  ["write back to jordan saying I'll vote by friday", 'draft_reply {"who":"Jordan","message":"I\'ll vote by Friday"}'],
  ["reply to the landlord and ask if the engineer can come at 10", 'draft_reply {"who":"landlord","message":"can the engineer come at 10?"}'],
  ["set up a meeting with Sam next week", 'propose_times {"who":"Sam","minutes":30}'],
  // waiting for others
  ["nudge Tom", 'nudge {"who":"Tom"}'],
  ["chase tom again", 'nudge {"who":"Tom"}'],
  ["nudge whoever I've been waiting on the longest", 'nudge {"who":"longest"}'],
  ["chase Tom and Priya", "nudge_all {}"],
  ["nudge priya and tom", "nudge_all {}"],
  ["who still owes me an answer and for how long", "waiting_on {}"],
  ["how long have i been waiting on tom", "waiting_on {}"],
  ["is priya still ignoring me", "waiting_on {}"],
  // notes
  ["how much is left of the kitchen budget if I go with quote B", 'notes_search {"query":"kitchen budget quote B"}'],
  ["what's the latest on the kitchen", 'notes_search {"query":"kitchen"}'],
  ["whats the plan for lisbon", 'notes_search {"query":"Lisbon plan"}'],
  ["how much is the insurance going up", 'notes_search {"query":"car insurance premium"}'],
  ["what's the kitchen budget again", 'notes_search {"query":"kitchen budget"}'],
  ["what's the difference between the two kitchen quotes", 'notes_search {"query":"kitchen quotes"}'],
  ["can you summarise my notes on the garden committee", 'notes_search {"query":"garden committee"}'],
  ["what did I plan to do in lisbon", 'notes_search {"query":"Lisbon plan"}'],
  ["remember that my landlord is called Alex", 'remember {"fact":"my landlord is called Alex"}'],
  // trips and weather
  ["when is my next flight and what hotel do I have", "trips {}"],
  ["what's the weather like in lisbon next week", 'weather {"query":"Lisbon"}'],
  ["do I need an umbrella tomorrow", "weather {}"],
  ["what's the weather in Barcelona this weekend", 'weather {"query":"Barcelona"}'],
  // the web
  ["who is the current president of france", 'web_search {"query":"current president of France"}'],
  ["who won the last formula 1 race", 'web_search {"query":"last Formula 1 race winner"}'],
  // the app, summaries
  ["I need to prepare for the committee tonight, what do I have on it", 'meeting_prep {"who":"committee"}'],
  ["show me what's waiting for my approval", "pending_approvals {}"],
  ["summarize this week for me", "weekly_review {}"],
  // things the app can't do
  ["delete the weekly recipes newsletter", 'unsupported {"reason":"deleting email"}'],
  ["book me a table for dinner on saturday", 'unsupported {"reason":"booking a restaurant"}'],
  ["buy me flowers for maria", 'unsupported {"reason":"buying things"}'],
  ["turn on do not disturb", 'unsupported {"reason":"device settings"}'],
  // written for the library (subjects outside the evaluation data)
  ["what matters most this morning", "priorities {}"],
  ["where should I start today", "priorities {}"],
  ["give me Elena's address", 'contact_lookup {"who":"Elena"}'],
  ["do I have an email address for the plumber", 'contact_lookup {"who":"plumber"}'],
  ["which hotel am I staying at in Rome", "trips {}"],
  ["what time do I land on Sunday", "trips {}"],
  ["will I need a jacket on my trip", "trip_weather {}"],
  ["any meetings left this afternoon", "agenda {}"],
  ["am I double booked anywhere next week", "agenda {}"],
  ["how long is the gap between my two meetings tomorrow", "agenda {}"],
  ["put a dentist checkup on the 12th at 4pm", "add_event {}"],
  ["book 2 hours on wednesday afternoon for the tax return", "add_event {}"],
  ["remind me on monday to send the rent receipt", "reminder {}"],
  ["remind me an hour before the vet to bring the papers", "reminder {}"],
  ["what are my open to-dos", "reminders_list {}"],
  ["did the school write back about the trip form", 'email_question {"query":"school trip form"}'],
  ["what did the accountant ask for", 'email_question {"query":"from:accountant"}'],
  ["show me the emails from the gym this month", 'email_search {"query":"from:gym","days":31}'],
  ["is there anything in my mail I still have to deal with", 'inbox_review {"days":7}'],
  ["tell Elena I'll be ten minutes late", 'draft_reply {"who":"Elena","message":"I\'ll be ten minutes late"}'],
  ["answer the plumber that monday suits me", 'draft_reply {"who":"plumber","message":"Monday suits me"}'],
  ["follow up with Elena about the invoice", 'nudge {"who":"Elena"}'],
  ["ping everyone who owes me an answer", "nudge_all {}"],
  ["who am I still waiting to hear back from", "waiting_on {}"],
  ["what did I note about the car service", 'notes_search {"query":"car service"}'],
  ["what were my ideas for the birthday party", 'notes_search {"query":"birthday party ideas"}'],
  ["note that my locker code is 4412", 'remember {"fact":"my locker code is 4412"}'],
  ["what's the weather like in Porto on friday", 'weather {"query":"Porto"}'],
  ["what time does the pharmacy on Gran Via close", 'web_search {"query":"pharmacy Gran Via opening hours"}'],
  ["how did the elections go yesterday", 'web_search {"query":"election results"}'],
  ["what's still waiting for me to approve", "pending_approvals {}"],
  ["call my mother", 'unsupported {"reason":"phone calls"}'],
  ["play some jazz", 'unsupported {"reason":"music"}'],
  // more variety (2026-10-16): other people, places and subjects than the evaluation data
  ["is my afternoon free", "agenda {}"],
  ["how many meetings do I have on monday", "agenda {}"],
  ["when do I finish today", "agenda {}"],
  ["what's my first appointment tomorrow", "agenda {}"],
  ["anything planned for the weekend", "agenda {}"],
  ["where is the parents evening", "agenda {}"],
  ["how long is the vet appointment", "agenda {}"],
  ["have I got a gap for lunch on wednesday", "agenda {}"],
  ["who am I meeting this afternoon", "agenda {}"],
  ["add physio next thursday at 11", "add_event {}"],
  ["put the school play on the 28th at 6pm", "add_event {}"],
  ["schedule a haircut friday at noon", "add_event {}"],
  ["create an event: team drinks thursday 7pm at The Anchor", "add_event {}"],
  ["block two hours tomorrow morning to write the report", "add_event {}"],
  ["add the parents evening from the school email to my calendar", 'event_from_email {"query":"parents evening"}'],
  ["find the concert tickets in my mail and put them in my calendar", 'event_from_email {"query":"concert tickets"}'],
  ["remind me to book the vet on friday", "reminder {}"],
  ["remind me at 6 to call the garage", "reminder {}"],
  ["in 30 minutes remind me to take the cake out", "reminder {}"],
  ["remind me the day before the school play to iron the costume", "reminder {}"],
  ["set a reminder for next monday morning to renew the parking permit", "reminder {}"],
  ["remind me before the gym membership renews", 'reminder_from_email {"query":"gym membership renewal"}'],
  ["turn the deadlines in my inbox into reminders", 'deadlines_to_reminders {"days":7}'],
  ["did the garage send the quote", 'email_question {"query":"from:garage quote"}'],
  ["what time did the school say pickup is", 'email_question {"query":"school pickup"}'],
  ["how much is the gym charging this month", 'email_question {"query":"gym"}'],
  ["what's the reference number for my parcel", 'email_question {"query":"parcel"}'],
  ["did Elena reply about the venue", 'email_question {"query":"from:Elena venue"}'],
  ["show me the emails from the garage", 'email_search {"query":"from:garage"}'],
  ["any mail from the council this week", 'email_search {"query":"council","days":7}'],
  ["find the parcel delivery email", 'email_search {"query":"parcel delivery"}'],
  ["what new emails came in this morning", 'email_search {"query":"in:inbox","days":1}'],
  ["is there anything urgent in my inbox today", 'inbox_review {"days":1}'],
  ["which emails still need an answer from me", 'inbox_review {"days":7}'],
  ["anything I have to sign or pay this month", 'inbox_review {"days":30}'],
  ["let Elena know the venue is booked", 'draft_reply {"who":"Elena","message":"the venue is booked"}'],
  ["answer the garage that I'll pick the car up at 5", 'draft_reply {"who":"garage","message":"I\'ll pick the car up at 5"}'],
  ["reply to the school saying Leo will be absent on friday", 'draft_reply {"who":"school","message":"Leo will be absent on Friday"}'],
  ["write to Omar that I can't make the meeting", 'draft_reply {"who":"Omar","message":"I can\'t make the meeting"}'],
  ["tell Omar yes to the barbecue and add it to my calendar", 'reply_and_add {"who":"Omar","message":"yes to the barbecue"}'],
  ["give Omar a few options for a call next week", 'propose_times {"who":"Omar","minutes":30}'],
  ["chase the garage about the quote", 'nudge {"who":"garage"}'],
  ["send a follow-up to Elena", 'nudge {"who":"Elena"}'],
  ["follow up with everyone I'm waiting on", "nudge_all {}"],
  ["who hasn't got back to me this week", "waiting_on {}"],
  ["has Omar answered my last email", 'email_question {"query":"from:Omar"}'],
  ["what's in my notes about the garden", 'notes_search {"query":"garden"}'],
  ["what did I write about the school trip", 'notes_search {"query":"school trip"}'],
  ["how much did I budget for the holiday", 'notes_search {"query":"holiday budget"}'],
  ["what's my wifi password note say", 'notes_search {"query":"wifi"}'],
  ["what are my goals for this year", 'notes_search {"query":"goals"}'],
  ["remember that Leo's school starts at 8:45", 'remember {"fact":"Leo\'s school starts at 8:45"}'],
  ["where am I flying next", "trips {}"],
  ["what's my train booking for sunday", "trips {}"],
  ["is it going to be hot where I'm travelling", "trip_weather {}"],
  ["will it rain this afternoon", "weather {}"],
  ["what's the forecast for Valencia on saturday", 'weather {"query":"Valencia"}'],
  ["how tall is the Eiffel Tower", 'web_search {"query":"Eiffel Tower height"}'],
  ["what's the latest news about the train strike", 'web_search {"query":"train strike news"}'],
  ["when does the museum of science open on sundays", 'web_search {"query":"museum of science Sunday opening hours"}'],
  ["when is the Valencia marathon? put it in my calendar", 'event_from_web {"query":"Valencia marathon date"}'],
  ["prepare me for my meeting with Omar", 'meeting_prep {"who":"Omar"}'],
  ["brief me on all of tomorrow's meetings", "prep_day {}"],
  ["how did my week go", "weekly_review {}"],
  ["what should I focus on right now", "priorities {}"],
  ["draft answers to everything waiting for my reply", "followups {}"],
  ["what's waiting for my OK", "pending_approvals {}"],
  ["when does the morning briefing run", "schedules {}"],
  ["what's Omar's email address", 'contact_lookup {"who":"Omar"}'],
  ["which streaming services am I paying for", "subscriptions {}"],
  ["cancel my gym membership", 'unsupported {"reason":"cancelling a membership"}'],
  ["order more printer ink", 'unsupported {"reason":"ordering things"}'],
  ["text my brother happy birthday", 'unsupported {"reason":"text messages"}'],
  ["set an alarm for 7", 'unsupported {"reason":"alarms"}'],
  ["delete the email from the council", 'unsupported {"reason":"deleting email"}'],
];

// Function words carry no meaning here; question words and verbs do ("who", "when", "add", "tell"), so they stay.
// "and" stays: "chase Tom and Priya" (everyone) is not "chase Tom".
const STOP = new Set("a an the my me i to of for is it its on in at be am are was or so u you your can could would please just".split(" "));

// Word families: different words for the same kind of request match each other ("snow" finds the weather examples,
// "pencil in" the calendar ones). The family is added next to the word, so exact words still count most.
const FAMILIES: [string, RegExp][] = [
  ["#weather", /^(?:weather|rain\w*|snow\w*|sunny|sun|forecast|umbrella|jacket|hot|cold|warm|temperature|wind\w*|storm\w*)$/],
  ["#add", /^(?:add|put|pencil|schedule|book|block|create|plan)$/],
  ["#chase", /^(?:chase|nudge|ping|follow|follow-up|remind)$/],
  ["#money", /^(?:owe|cost|price|much|pay|paying|paid|bill|bills|charge|charging|invoice|fee)$/],
  ["#write", /^(?:reply|answer|respond|tell|write|let|say|message|email)$/],
  ["#note", /^(?:note|notes|noted|wrote|written|jot)$/],
  ["#when", /^(?:when|time|what time|date|day)$/],
  ["#free", /^(?:free|busy|gap|available|space)$/],
];

const tokens = (text: string, names: Set<string>) =>
  text
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    // People are interchangeable: "nudge Tom" teaches the same as "nudge Ana".
    .flatMap((t) => {
      if (names.has(t)) return ["@person"];
      const family = FAMILIES.find(([, re]) => re.test(t))?.[0];
      return family ? [stem(t), family] : [stem(t)];
    });

const LIB_NAMES = ["maria", "tom", "priya", "jordan", "sam", "landlord", "alex", "marc", "ana", "laura", "elena", "plumber", "accountant", "omar", "leo", "garage", "school"];

/** The k library requests most like `text` (idf-weighted word overlap; names count as one "person" word), best first. */
export function similarExamples(text: string, k = 6, people: string[] = [], own: [string, string][] = []): [string, string][] {
  const names = new Set([...LIB_NAMES, ...people.map((p) => p.toLowerCase())]);
  // The user's own corrections first: for the same words, their choice is the one shown.
  const ownKeys = new Set(own.map(([q]) => q.trim().toLowerCase()));
  const lib = [...own, ...LIBRARY.filter(([q]) => !ownKeys.has(q.trim().toLowerCase()))].map(([q, r]) => ({ q, r, t: new Set(tokens(q, names)) }));
  const df = new Map<string, number>();
  for (const e of lib) for (const t of e.t) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + lib.length / (df.get(t) ?? 0.5));
  const q = new Set(tokens(text, names));
  if (!q.size) return [];
  const qWeight = [...q].reduce((s, t) => s + idf(t), 0);
  return lib
    .map((e) => {
      let shared = 0;
      for (const t of q) if (e.t.has(t)) shared += idf(t);
      const eWeight = [...e.t].reduce((s, t) => s + idf(t), 0);
      return { e, score: shared / Math.sqrt(qWeight * eWeight || 1) };
    })
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => [x.e.q, x.e.r]);
}
