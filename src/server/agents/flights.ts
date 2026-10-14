import { all, type Ctx } from "../db";
import { demoRowsFilter } from "../mode";
import { allDayEvent, localToday, type PreparedEvent, type Ymd } from "./eventParse";

/**
 * Flights from booking confirmations, read from the subject line only (no message body): airlines
 * put the route as airport codes and the date there, e.g.
 *   "Volotea • Your booking confirmation: LYS-OPO • 14 March 2027 • R2D7QK"
 *   "Confirmación de tu reserva QWERTY - VLC-TFN 05 marzo, TFN-VLC 09 marzo"
 * Departure times are rarely in the subject, so flights become all-day events for the user to
 * review; nothing is added without their click.
 */

export interface FlightLeg {
  from: string;
  to: string;
  date: Ymd;
  /** Departure time when the subject has one ("07:40"); otherwise the event is all-day without it. */
  time: string | null;
  airline: string | null;
  ref: string | null;
  bookingId: string;
}

// English, French, Spanish and Catalan month names, matched by their first letters.
const MONTHS: [RegExp, number][] = [
  [/^(jan|janv|ene|gen)/, 1], [/^(feb|f[ée]v|febr)/, 2], [/^mar/, 3], [/^(apr|avr|abr)/, 4],
  [/^(may|mai|mayo|maig)/, 5], [/^(jun|juin|juny)/, 6], [/^(jul|juil|juliol)/, 7], [/^(aug|ao[uû]|ago|agost)/, 8],
  [/^(sep|set)/, 9], [/^oct/, 10], [/^nov/, 11], [/^(d[ée]c|dic|des)/, 12],
];
const MONTH_WORD =
  "(january|janvier|enero|gener|jan|janv|ene|gen|february|f[ée]vrier|febrero|febrer|feb|f[ée]v|march|mars|marzo|març|mar|april|avril|abril|apr|avr|abr|may|mai|mayo|maig|june|juin|junio|juny|jun|july|juillet|julio|juliol|jul|juil|august|ao[uû]t|agosto|agost|aug|ago|september|septembre|septiembre|setiembre|setembre|sept?|set|october|octobre|octubre|oct|november|novembre|noviembre|nov|december|d[ée]cembre|diciembre|desembre|dec|d[ée]c|dic|des)\\.?";
// "28 December 2026", "20 décembre 2026", "05 febrero", "1er mars", "7 de febrer de 2027", "28/12/2026"
const DATE = new RegExp(`(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(?:de\\s+|d')?${MONTH_WORD}(?:\\s+(?:de\\s+)?(\\d{4}))?|(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?`, "iu");
const LEG = /(?<![A-Za-z])([A-Z]{3})\s*(?:-|–|—|>|→|to)\s*([A-Z]{3})(?![A-Za-z])/g;
// A booking reference: 6 capital letters/digits standing alone (QWERTY, R2D7QK), never a route code.
const REF = /(?<![A-Za-z0-9-])([A-Z0-9]{6})(?![A-Za-z0-9-])/;

const monthNumber = (w: string) => MONTHS.find(([re]) => re.test(w.toLowerCase()))?.[1] ?? null;

function isRealDate({ y, m, d }: Ymd) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const ymdKey = ({ y, m, d }: Ymd) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** A day and month without a year: the first such date on or after the day the email arrived. */
function withYear(d: number, m: number, year: number | null, received: Ymd): Ymd {
  if (year) return { y: year < 100 ? 2000 + year : year, m, d };
  const same = { y: received.y, m, d };
  return ymdKey(same) >= ymdKey(received) ? same : { y: received.y + 1, m, d };
}

function parseDate(text: string, received: Ymd): Ymd | null {
  const m = text.match(DATE);
  if (!m) return null;
  const date = m[1] ? (() => {
    const month = monthNumber(m[2]);
    return month ? withYear(+m[1], month, m[3] ? +m[3] : null, received) : null;
  })() : withYear(+m[4], +m[5], m[6] ? +m[6] : null, received);
  return date && isRealDate(date) ? date : null;
}

function airlineOf(sender: string, subject: string): string | null {
  const known = ["Volotea", "Vueling", "Ryanair", "easyJet", "Iberia", "Air France", "Transavia", "Lufthansa", "KLM", "British Airways", "Wizz Air", "Air Europa", "TAP", "Binter", "Norwegian", "Swiss", "ITA Airways"];
  const hay = `${sender} ${subject}`.toLowerCase();
  return known.find((a) => hay.includes(a.toLowerCase().replace(/ /g, "")) || hay.includes(a.toLowerCase())) ?? (sender.replace(/\s*<[^>]*>/, "").replace(/"/g, "").trim() || null);
}

/** Every leg in one subject: a route followed by its date (a leg without a date is left out). */
export function parseFlightSubject(subject: string, sender: string, receivedAt: Date, tz: string, bookingId = ""): FlightLeg[] {
  const received = localToday(receivedAt, tz);
  const legs = [...subject.matchAll(LEG)];
  const refMatch = subject.replace(LEG, " ").match(REF);
  const ref = refMatch && /[A-Z]/.test(refMatch[1]) ? refMatch[1] : null;
  const airline = airlineOf(sender, subject);
  const out: FlightLeg[] = [];
  legs.forEach((leg, i) => {
    // The date belongs to this leg: look between this route and the next one.
    const after = subject.slice(leg.index! + leg[0].length, legs[i + 1]?.index ?? subject.length);
    const date = parseDate(after, received) ?? (legs.length === 1 ? parseDate(subject.slice(0, leg.index), received) : null);
    const time = after.match(/(?<!\d)([01]?\d|2[0-3])[:h]([0-5]\d)(?!\d)/);
    if (date) out.push({ from: leg[1], to: leg[2], date, time: time ? `${time[1].padStart(2, "0")}:${time[2]}` : null, airline, ref, bookingId });
  });
  return out;
}

/** Upcoming flights from the stored booking confirmations, once each (several emails can repeat a leg). */
export function upcomingFlights(ctx: Ctx, tz: string): FlightLeg[] {
  const rows = all<{ id: string; sender: string; subject: string; received_at: string }>(ctx.db, `SELECT id, sender, subject, received_at FROM bookings WHERE kind = 'flight'${demoRowsFilter()} ORDER BY received_at DESC`);
  const today = ymdKey(localToday(ctx.now(), tz));
  const seen = new Map<string, FlightLeg>();
  for (const r of rows) {
    for (const leg of parseFlightSubject(r.subject, r.sender, new Date(r.received_at), tz, r.id)) {
      const key = `${leg.from}-${leg.to}-${ymdKey(leg.date)}`;
      if (ymdKey(leg.date) >= today && !seen.has(key)) seen.set(key, leg);
    }
  }
  return [...seen.values()].sort((a, b) => ymdKey(a.date).localeCompare(ymdKey(b.date)));
}

export function flightKey(leg: FlightLeg) {
  return `${leg.from}-${leg.to}-${ymdKey(leg.date)}`;
}

/** The calendar event for one leg: all day, titled with the route, airline and booking reference. */
export function flightEvent(leg: FlightLeg, tz: string, now: Date): PreparedEvent {
  const extra = [leg.airline, leg.ref].filter(Boolean).join(" ");
  return allDayEvent(`Flight ${leg.from} → ${leg.to}${leg.time ? ` ${leg.time}` : ""}${extra ? ` (${extra})` : ""}`, null, leg.date, tz, now);
}

/** True if the calendar already has something for this flight on that day (same route or a flight word). */
export function alreadyInCalendar(ctx: Ctx, leg: FlightLeg, tz: string): boolean {
  const ev = allDayEvent("x", null, leg.date, tz, ctx.now());
  const rows = all<{ title: string }>(ctx.db, `SELECT title FROM events WHERE starts_at >= ? AND starts_at < ?${demoRowsFilter()}`, ev.startsAt, ev.endsAt);
  const words = new RegExp(`(?<![A-Za-z])(${leg.from}|${leg.to})(?![A-Za-z])|flight|vol\\b|vuelo|✈`, "i");
  return rows.some((r) => words.test(r.title));
}
