import { randomUUID } from "node:crypto";

/**
 * Turns "dentist tuesday 3pm at Riverside Dental" into a calendar event, with plain rules (no LLM):
 * the text is the user's own, and the result is only ever shown to them for review. Nothing is
 * written anywhere: the user adds it to Google Calendar themselves (pre-filled Google page) or
 * downloads an .ics file. Numeric dates are day/month (14/10 = 14 October).
 */

export interface PreparedEvent {
  title: string;
  location: string | null;
  allDay: boolean;
  /** Wall-clock times in `timezone`: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM". */
  start: string;
  end: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  googleUrl: string;
  ics: string;
}

// English and French. Month and weekday words map to numbers through their first letters.
const MONTH_RE =
  "(jan(?:uary)?|janv(?:ier)?|feb(?:ruary)?|f[ée]vr?(?:ier)?|mar(?:ch|s)?|apr(?:il)?|avr(?:il)?|may|mai|june?|juin|july?|juil(?:let)?|aug(?:ust)?|ao[uû]t|sep(?:t(?:ember|embre)?)?|oct(?:ober|obre)?|nov(?:ember|embre)?|d[ée]c(?:ember|embre)?)\\.?";
const MONTH_PREFIXES: [RegExp, number][] = [
  [/^jan/, 1], [/^f[eé]v|^feb/, 2], [/^mar/, 3], [/^apr|^avr/, 4], [/^may|^mai/, 5], [/^juin|^jun/, 6],
  [/^juil|^jul/, 7], [/^aug|^ao/, 8], [/^sep/, 9], [/^oct/, 10], [/^nov/, 11], [/^d[eé]c/, 12],
];
const WEEKDAY_RE = "(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)";
const WEEKDAY_PREFIXES: [RegExp, number][] = [
  [/^sun|^dim/, 0], [/^mon|^lun/, 1], [/^tue|^mar/, 2], [/^wed|^mer/, 3], [/^thu|^jeu/, 4], [/^fri|^ven/, 5], [/^sat|^sam/, 6],
];
const monthNumber = (w: string) => MONTH_PREFIXES.find(([re]) => re.test(w.toLowerCase()))![1];
const weekdayNumber = (w: string) => WEEKDAY_PREFIXES.find(([re]) => re.test(w.toLowerCase()))![1];
const TIME = "(\\d{1,2})(?:[:h.](\\d{2})|h)?\\s*(am|pm)?"; // 3pm, 15:00, 15h30, 15h

export type Ymd = { y: number; m: number; d: number };
const pad = (n: number) => String(n).padStart(2, "0");
const fmtYmd = ({ y, m, d }: Ymd) => `${y}-${pad(m)}-${pad(d)}`;
const addDays = ({ y, m, d }: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** Calendar date and minutes-since-midnight of `now` in `tz`. */
function localNow(now: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: { y: +parts.year, m: +parts.month, d: +parts.day }, minutes: +parts.hour * 60 + +parts.minute };
}

/** The UTC instant of a wall-clock time in `tz` (handles DST by correcting once). */
export function zonedToUtc(date: Ymd, minutes: number, tz: string): Date {
  const guess = Date.UTC(date.y, date.m - 1, date.d, 0, minutes);
  const offset = (at: number) => {
    const p = localNow(new Date(at), tz);
    return Date.UTC(p.date.y, p.date.m - 1, p.date.d, 0, p.minutes) - at;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

function toMinutes(h: string, min: string | undefined, ampm: string | undefined): number | null {
  let hour = Number(h);
  const minute = min ? Number(min) : 0;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function parseEventRequest(text: string, now: Date, tz: string): PreparedEvent | { error: string } {
  let s = ` ${text.replace(/\s+/g, " ").trim()} `;
  const take = (re: RegExp) => {
    const m = s.match(re);
    if (m) s = s.replace(m[0], " ");
    return m;
  };
  const today = localNow(now, tz);

  // ---- time: a range, a single time, or noon/midnight; then an optional duration
  let start: number | null = null;
  let end: number | null = null;
  // Only a range if one side has minutes, am/pm or "h" ("3-4pm", "10:00 to 11:30", "10h à 11h"), not "2-3 people".
  const range = s.match(new RegExp(`\\s(?:from\\s+|de\\s+)?${TIME}\\s*(?:-|–|to|until|till|à|jusqu'à)\\s*${TIME}(?=\\s)`, "i"));
  if (range && (range[2] || range[3] || range[5] || range[6] || /\dh/i.test(range[0]))) {
    s = s.replace(range[0], " ");
    // "3-4pm": the first time borrows the second's am/pm.
    start = toMinutes(range[1], range[2], range[3] ?? range[6]);
    end = toMinutes(range[4], range[5], range[6]);
    if (start === null || end === null) return { error: "That time range doesn't look right. Try “3pm-4pm” or “15:00 to 16:30”." };
    // ...unless that puts it after the end: "11-1pm" is 11am to 1pm, not 11pm.
    if (!range[3] && range[6] && start >= end && start >= 12 * 60) start -= 12 * 60;
  } else {
    const single =
      take(new RegExp(`\\s(?:(?:at|à)\\s+)?(\\d{1,2})(?:[:h.](\\d{2}))?\\s*(am|pm)(?=\\s)`, "i")) ??
      take(/\s(?:(?:at|à)\s+)?(\d{1,2})[:h](\d{2})(?=\s)/i) ??
      take(/\s(?:(?:at|à)\s+)?(\d{1,2})h()(?=\s)/i); // "15h"
    if (single) {
      start = toMinutes(single[1], single[2], single[3]);
      if (start === null) return { error: "That time doesn't look right. Try “3pm” or “15:00”." };
    } else if (take(/\s(?:(?:at|à)\s+)?(?:noon|midi)(?=\s)/i)) start = 12 * 60;
    else if (take(/\s(?:(?:at|à)\s+)?(?:midnight|minuit)(?=\s)/i)) start = 0;
  }
  const duration = take(/\s(?:for|pendant|pour)\s+(an?|half an|une|\d+(?:\.\d+)?)\s*(hours?|hrs?|heures?|h|minutes?|mins?|m)(?=\s)/i);
  if (start !== null && end === null) {
    let mins = 60;
    if (duration) {
      const n = /^half/i.test(duration[1]) ? 0.5 : /^(an?|une)$/i.test(duration[1]) ? 1 : Number(duration[1]);
      mins = Math.round(/^h/i.test(duration[2]) ? n * 60 : n);
    }
    end = start + Math.max(5, mins);
  }

  // ---- date
  let date: Ymd | null = null;
  let m: RegExpMatchArray | null;
  if ((m = take(/\s(?:on\s+)?(\d{4})-(\d{2})-(\d{2})(?=\s)/))) date = { y: +m[1], m: +m[2], d: +m[3] };
  else if (take(/\s(?:(?:the\s+)?day after tomorrow|apr[eè]s-demain)(?=\s)/i)) date = addDays(today.date, 2);
  else if (take(/\s(?:today|tonight|aujourd'hui|ce soir)(?=\s)/i)) date = today.date;
  else if (take(/\s(?:tomorrow|demain)(?=\s)/i)) date = addDays(today.date, 1);
  else if ((m = take(/\s(?:in|dans)\s+(\d{1,2})\s+(days?|weeks?|jours?|semaines?)(?=\s)/i))) date = addDays(today.date, +m[1] * (/^(w|s)/i.test(m[2]) ? 7 : 1));
  else if ((m = take(new RegExp(`\\s(?:on\\s+|le\\s+)?(?:(next|this|ce)\\s+)?${WEEKDAY_RE}(?:\\s+(prochain))?(?=\\s)`, "i")))) {
    const target = weekdayNumber(m[2]);
    const current = new Date(Date.UTC(today.date.y, today.date.m - 1, today.date.d)).getUTCDay();
    let ahead = (target - current + 7) % 7;
    if (ahead === 0 && !/^(this|ce)$/i.test(m[1] ?? "")) ahead = 7;
    date = addDays(today.date, ahead);
  } else if ((m = take(new RegExp(`\\s(?:on\\s+|le\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(?:of\\s+)?${MONTH_RE}(?:\\s+(\\d{4}))?(?=\\s)`, "i")))) {
    date = withYear(+m[1], monthNumber(m[2]), m[3], today.date);
  } else if ((m = take(new RegExp(`\\s(?:on\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s)`, "i")))) {
    date = withYear(+m[2], monthNumber(m[1]), m[3], today.date);
  } else if ((m = take(/\s(?:on\s+|le\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/))) {
    date = withYear(+m[1], +m[2], m[3] && m[3].length === 2 ? `20${m[3]}` : m[3], today.date);
  }
  if (date && !isRealDate(date)) return { error: "That date doesn't exist. Dates are day/month, e.g. 14/10 for 14 October." };
  if (!date) {
    if (start === null) return { error: "When is it? Add a day and time, e.g. “tomorrow 3pm” or “14/10 10:00-11:30”." };
    date = start > today.minutes ? today.date : addDays(today.date, 1); // a bare time means its next occurrence
  }

  // ---- location ("@ X", "at X", "in X" at the end), then the title is what is left
  let location: string | null = null;
  const loc = take(/\s(@|at|in|à|chez)\s+(?!\d)([^@]+?)\s*$/i);
  if (loc && !/^(noon|midnight|the morning|the afternoon|the evening|midi|minuit)$/i.test(loc[2])) {
    location = `${loc[1].toLowerCase() === "chez" ? "chez " : ""}${loc[2].trim().replace(/[.,;]+$/, "")}`;
  }
  else if (loc) s = `${s} ${loc[0]}`;
  const title = s.replace(/\s(?:on|at|from|for|the|le|à|de|pour)\s*$/i, " ").replace(/^\s*(?:an?|the|une?|le|la)\s+/i, " ").replace(/\s+[,;]\s*|\s*,\s*$/g, " ").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (!title) return { error: "What is the event? e.g. “add event: dentist tuesday 3pm”." };

  const allDay = start === null;
  let endDate = date;
  let endMin = end ?? 0;
  if (!allDay && endMin <= start!) {
    endDate = addDays(date, 1); // "11pm-1am" ends the next day
  }
  if (!allDay && endMin >= 24 * 60) {
    endDate = addDays(date, Math.floor(endMin / (24 * 60)));
    endMin %= 24 * 60;
  }
  const startsAt = allDay ? zonedToUtc(date, 0, tz) : zonedToUtc(date, start!, tz);
  const endsAt = allDay ? zonedToUtc(addDays(date, 1), 0, tz) : zonedToUtc(endDate, endMin, tz);
  const hm = (x: number) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
  const event = {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    location,
    allDay,
    start: allDay ? fmtYmd(date) : `${fmtYmd(date)}T${hm(start!)}`,
    end: allDay ? fmtYmd(date) : `${fmtYmd(endDate)}T${hm(endMin)}`,
    timezone: tz,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
  return { ...event, googleUrl: googleCalendarUrl(event, date), ics: toIcs(event, now) };
}

function withYear(d: number, m: number, year: string | undefined, today: Ymd): Ymd {
  if (year) return { y: +year, m, d };
  const thisYear = { y: today.y, m, d };
  return fmtYmd(thisYear) < fmtYmd(today) ? { y: today.y + 1, m, d } : thisYear;
}

function isRealDate({ y, m, d }: Ymd) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && t.getUTCDate() === d && t.getUTCMonth() === m - 1;
}

type EventCore = Omit<PreparedEvent, "googleUrl" | "ics">;

/** Google's own "create event" page, pre-filled. The user reviews and saves it there; the app writes nothing. */
function googleCalendarUrl(e: EventCore, date: Ymd): string {
  const compact = (v: string) => v.replace(/[-:]/g, "");
  const dates = e.allDay ? `${compact(fmtYmd(date))}/${compact(fmtYmd(addDays(date, 1)))}` : `${compact(e.start)}00/${compact(e.end)}00`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates });
  if (!e.allDay) params.set("ctz", e.timezone);
  if (e.location) params.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** A standard iCalendar file (works with Google, Apple and Outlook calendars). */
function toIcs(e: EventCore, now: Date): string {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const utc = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Agent Command Center//EN",
    "BEGIN:VEVENT",
    `UID:${randomUUID()}@agent-command-center`,
    `DTSTAMP:${utc(now.toISOString())}`,
    ...(e.allDay ? [`DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${fmtNextDay(e.start)}`] : [`DTSTART:${utc(e.startsAt)}`, `DTEND:${utc(e.endsAt)}`]),
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Today's date in `tz`. */
export function localToday(now: Date, tz: string): Ymd {
  return localNow(now, tz).date;
}

/** An all-day event on `date`, with its Google pre-filled link and .ics file (e.g. a flight from a booking email). */
export function allDayEvent(title: string, location: string | null, date: Ymd, tz: string, now: Date): PreparedEvent {
  const event = {
    title,
    location,
    allDay: true,
    start: fmtYmd(date),
    end: fmtYmd(date),
    timezone: tz,
    startsAt: zonedToUtc(date, 0, tz).toISOString(),
    endsAt: zonedToUtc(addDays(date, 1), 0, tz).toISOString(),
  };
  return { ...event, googleUrl: googleCalendarUrl(event, date), ics: toIcs(event, now) };
}

function fmtNextDay(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return fmtYmd(addDays({ y, m, d }, 1)).replace(/-/g, "");
}

/** An event on `date` from `start` to `end` ("HH:MM", end defaults to an hour later), or all day without a start. */
export function eventOn(title: string, location: string | null, date: Ymd, start: string, end: string, tz: string, now: Date): PreparedEvent {
  const minutes = (t: string) => (/^([01]?\d|2[0-3]):([0-5]\d)$/.test(t) ? +t.split(":")[0] * 60 + +t.split(":")[1] : null);
  const from = minutes(start);
  if (from === null) return allDayEvent(title, location, date, tz, now);
  let to = minutes(end) ?? from + 60;
  let endDate = date;
  if (to <= from) endDate = addDays(date, 1); // "22:00–01:00" ends the next day
  if (to >= 24 * 60) {
    endDate = addDays(date, 1);
    to -= 24 * 60;
  }
  const hm = (x: number) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
  const event = {
    title,
    location,
    allDay: false,
    start: `${fmtYmd(date)}T${hm(from)}`,
    end: `${fmtYmd(endDate)}T${hm(to)}`,
    timezone: tz,
    startsAt: zonedToUtc(date, from, tz).toISOString(),
    endsAt: zonedToUtc(endDate, to, tz).toISOString(),
  };
  return { ...event, googleUrl: googleCalendarUrl(event, date), ics: toIcs(event, now) };
}
