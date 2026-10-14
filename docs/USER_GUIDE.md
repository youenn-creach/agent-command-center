# User guide

A plain-language tour of Agent Command Center: what each page does, how approvals work, and what you can ask it. For setup see the README, for Google see [GOOGLE_SETUP.md](GOOGLE_SETUP.md), and for the safety model see [SECURITY.md](SECURITY.md).

## The idea in one paragraph

A few small **agents** (Inbox, Calendar, Follow-up, Knowledge, coordinated by the Chief of Staff) read the services you allow, prepare things for you, and wait. They **never act on their own**: anything that would leave the dashboard (an email draft, a calendar event, a webhook call) lands in the **Action Queue**, and only happens after you approve that exact content. The text they write comes from a **local model** on your computer; nothing is sent to a hosted AI.

## Two apps

| Address | What it is |
|---|---|
| http://127.0.0.1:3000 | **Your app.** Your real Gmail, Calendar, notes and reminders. No fictional data. |
| http://127.0.0.1:3001 | **The demo.** Fictional inbox, calendar and notes, to try things or show someone. It can't connect real accounts. |

They have separate data. The link at the top right switches between them.

## Pages

**Today.** Your day at a glance:
- **Impact this week**: what the assistant did for you over the last 7 days. Conversations revived (someone answered after a nudge you approved), nudges and replies approved, trips and bookings tracked (and how many became reminders), subscriptions that look paid, and an *estimated* time saved. Everything is counted from what actually happened; only the time is an estimate, and "How the time saved is estimated" shows the minutes used for each item. Drafts you dismissed count as zero;
- your agenda and the messages waiting on your reply;
- the latest briefing and your reminders;
- **Running now**: appears while something works (a Ctrl+K request, a scheduled task, the local model): what it is, its stage (“Reading email 4 of 12…”), how long it has run, CPU and memory, the busiest programs, and a plain sentence on the **bottleneck** (the model using all the CPU, another program hogging it, or low memory). When nothing runs it shrinks to one “Idle” line with the model held in memory.
- **Your requests**: everything you asked with Ctrl+K, and where it is now (waiting for approval, done…). Click one to jump to it.

**Action Queue.** Everything the agents prepared, waiting for you:
- read it and edit it if needed, then **Approve** and **Execute**;
- editing an approved item clears the approval, so you always approve the final version;
- **Dismiss** what you don't want.

**Inbox insights.** What your mail says you might be forgetting. It reads only email headers (sender, subject, date), never the text, and changes nothing in Gmail.
- **Still no answer**: threads where you wrote last, three or more days ago. **Draft a nudge** prepares a short follow-up in the same thread, for your approval.
- **Trips & bookings**: flight, train, hotel, restaurant and ticket confirmations from the last 6 months. **Remind me** adds a reminder.
- **Subscriptions**: senders you can unsubscribe from, flagging the ones that look paid. **Open in Gmail** shows their emails; you unsubscribe yourself.

**Agents.** Who does what, what each one may access, and whether it is working or on standby. The sidebar shows the same at a glance.

**Scheduled Agents.** The automatic runs, such as the morning briefing (weekdays 08:30), the Friday follow-up sweep and the Sunday weekly review (which also refreshes the subscription audit when the Inbox agent can read Gmail). You can pause, edit, run now or create one; schedules run at most every 15 minutes.

**Connections & Permissions.** What is connected, and what each agent may do with it.
- **Service access** (the top table) is the most anything may do on that service.
- **Agent permissions** (the matrix) is what each agent may do. The line under each choice ("can Read", "no access") is what it can *actually* do: the lower of the two.
- A dash means that agent's role never uses that service, so it can't be granted.

| Level | Meaning |
|---|---|
| None | No access |
| Read | Can look |
| Prepare | Can draft; nothing leaves the dashboard |
| Write with approval | Can act, but only after you approve each item |

**Knowledge & Data.** Your notes and imports (CSV, Markdown), plus **About me**: short facts the agents use when writing for you (for example "I sign emails as Sam", "I prefer short, informal replies", "I work 9:00–17:30"). You can also export or delete your data here.
- **Share to Atlas** (on each of your notes, off by default): sends that note to your MongoDB Atlas cluster, embedded with Voyage AI, so the Atlas search modes in *Under the hood* can find it. It needs Atlas live mode turned on first. Email never goes there. Untick it to remove the note from Atlas; deleting the note or "Clear my data" removes it there too, and if Atlas can't be reached nothing changes until it can.

**Under the hood.** The search lab: ask a question of your notes with each search method side by side, see every step (embedding, Atlas query, rerank), and compare their measured accuracy on the chart.

**Activity Log.** Everything that happened, including every refusal, newest first.

**Settings.**
- **Display**: Simple view hides the technical details.
- **Local language models**: pick a model per task. **Offload when idle** or **Offload now** frees the computer's memory.
- **Calendar events**: who adds them (see below).
- **Notifications**: your desktop and/or your phone.
- Also: news sources, weather, automations (webhooks) and data retention.

## Ctrl+K: ask the Chief of Staff

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> and ask in your own words. The local model (Ministral 3B by default) reads your request and picks one of the assistant's skills; ordinary code then does the work, under the same permissions as the agents. Understanding a request takes about 10–40 seconds on a laptop (the model warms up as soon as you open the bar); the reply says how it was understood.

| Ask, for example | What happens |
|---|---|
| “anything in my email this week that needs me?” · “any bills to pay?” · “anything important in my spam?” | First scans the subjects of your recent emails, then reads in full (up to 15) the ones that might need you, and lists what needs action (reply owed, bill, deadline, signature), most urgent first, then what's worth knowing (an approval, a cancellation, a security notice). Newsletters are skipped. Takes about 10–20 minutes on this laptop: the answer appears under **Your requests** on Today |
| “did Marc answer about the apartment?” · “find the invoice from Endesa” | Searches Gmail (headers only) |
| “what's my booking reference for the Lisbon hotel?” · “how much was my last electricity bill?” | Finds the emails, reads them and answers with sources |
| “prep me for my meeting with Laura” | A short brief from the calendar entry, recent emails and your notes |
| “what's on tomorrow?” · “am I free friday afternoon?” · “what do I have next week?” | Your calendar for that day or period, with overlaps flagged |
| “put dinner with Laura on saturday at 8pm in my calendar” · “block monday morning for deep work” | Prepares the event (see below) |
| “add my flights to my calendar” | One event per upcoming flight found in your booking emails |
| “check when I registered for the race in my emails and add it to my calendar” · “put the concert I bought tickets for in my calendar” | Searches your mail (also in French, Spanish and Catalan), reads the best matches, takes the event's date, time and place from them and prepares the event for your approval. It never guesses a date, and tells you if the event is already over or already in your calendar |
| “remind me to call mom tomorrow at 6pm” | A reminder on Today, due at that time |
| “reply to Ana that Thursday works” | The local model writes the reply in Ana's language; it waits for your approval as a Gmail draft |
| “chase Priya about the quote” · “who hasn't answered me?” | A polite follow-up in the same thread, for approval · the list of quiet threads |
| “what trips do I have coming up?” · “what am I paying for every month?” | Trips and bookings · subscriptions that look paid |
| “what did I note about the kitchen?” | An answer from your notes, with the notes it used |
| “weather in Barcelona tomorrow?” | Open-Meteo forecast, up to 7 days |
| “remind me to pay the electricity bill before it's due” · “…a week before it expires” | Finds the bill or renewal in your mail, reads what to do and the deadline, and adds a reminder ahead of it (2 days by default, 09:00) |
| “add the deadlines from my emails this week to my reminders” | The email review above, then one reminder per action (the day before each deadline) |
| “what's the weather on my trip?” | Your next flight's destination and dates from your booking emails, and its forecast (up to 7 days ahead) |
| “prep me for tomorrow's meetings” | A brief for each meeting of that day (three at most) |
| “chase everyone who hasn't answered me” | One polite follow-up per waiting conversation (five at most), each waiting for your approval |
| “when is the Paris marathon? add it to my calendar” | Finds the date on the web, then prepares the event for your approval |
| “tell Laura yes for dinner and add it to my calendar” | A reply draft to Laura and the dinner from her email as an event, both for your approval |
| “who won the final last night?” · “opening hours of the Picasso museum?” | Searches the web privately through your own SearXNG on this computer, reads the top three pages and answers with numbered sources (a few minutes). Off until you give the Knowledge agent Read on **Web search** in Connections & Permissions. Setup: [WEB_SEARCH.md](WEB_SEARCH.md) |
| “brief me” · “weekly review” · “what's waiting for me?” · “what's scheduled?” · “remember I prefer short replies” | Runs or answers from the dashboard |

Exact commands still work instantly, without the model: `add event: dentist tuesday 3pm`, `draft reply to Ana: sounds good!`, `propose times to Ana`, `remember …`, `trigger Todoist: buy milk`, and French `rdv : dîner chez Julien vendredi 20h`. Dates: `tomorrow`, `friday`, `next tuesday`, `24/10` (day/month), `24 october`, `in 3 days`; times: `3pm`, `15:00`, `15h`, `3-4pm`, `for 45 min`. Without a time, an event lasts all day.

**What it won't do.** It never sends, approves, deletes, pays or changes permissions (those are yours, on the right page), and it never handles passwords. It can't book or buy: it says so instead of guessing. Emails it reads are untrusted: they're shown to the model as data, never stored, and an email that tries to instruct an AI isn't shown to the model at all (you're told to check it yourself).

**Your requests** (Today) keeps every request with its status and answer: click one to read it. Long requests show their progress (“Reading email 4 of 18…”) and notify you when ready if notifications are on.

## Calendar events: two ways

In **Settings → Calendar events**:
- **The app adds it, after you approve** (default): the Ctrl+K card shows **Approve and add to calendar**. Events go to a separate "Agent Command Center" calendar, shown next to yours in Google Calendar. The app can't see or change your other calendars. This needs the "Google Calendar: app calendar" connection (Connections & Permissions).
- **I add it myself**: the card opens Google's own new-event page, already filled in; you click Save there.

## Notifications

**Settings → Notifications**:
- **Desktop**: a pop-up on this computer.
- **Phone**: install the free **ntfy** app and subscribe to your private topic (shown in Settings). Phone messages stay generic ("something is waiting for your approval") unless you tick "include details".

You can be notified when something waits for approval, the briefing is ready, someone hasn't answered, a booking is found, or a scheduled task fails. Each event notifies once, at most 12 an hour.

## Languages

Emails in any language are synced and shown. Some features read the words and know **English, French, Spanish and Catalan**: the warning for emails that try to instruct an AI, Trips & bookings, the subscription audit and "looks paid".

Reply drafts are written in the email's language, and each language can use its own local model (Settings → Local language models → Reply drafts by language). After comparing models on fictional emails, the setup is:
- **English and Spanish:** ministral 3B (the background model).
- **French:** Gemma 3 4B. It reads naturally and doesn't invent facts.
- **Catalan:** Salamandra 7B, trained in Barcelona with a lot of Catalan. It writes the best Catalan, but it's slower (one to three minutes a draft, in the background), and it once greeted the wrong person, so glance at the greeting.

If a draft comes back in the wrong language, it's retried once and otherwise replaced by a short holding reply in the right language. Ctrl+K understands English and French.

## When something looks wrong

- **"Ollama off" in the sidebar**: the local model isn't running. Briefings still work with a plain template.
- **A schedule says "blocked"**: an agent lost a permission it needs. The reason is shown, and it unblocks by itself when the permission is back.
- **The computer feels slow**: Settings → Local language models → **Offload now**.
- **Backups**: `npm run db:backup` (they're also taken before every update).
