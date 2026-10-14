import { zonedToUtc } from "./eventParse";

/**
 * Free time to offer someone: weekday slots inside working hours that don't overlap anything on
 * the calendar (with a small buffer), spread over different days. Plain arithmetic, no LLM.
 */

export interface SlotOptions {
  durationMin: number;
  count?: number;
  days?: number;
  /** Working hours, minutes since midnight in `tz`. */
  workStart?: number;
  workEnd?: number;
  bufferMin?: number;
  /** Don't offer anything sooner than this (minutes from now). */
  noticeMin?: number;
}

type Busy = { starts_at: string; ends_at: string };
type Ymd = { y: number; m: number; d: number };

function localDate(at: Date, tz: string): Ymd & { weekday: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

export function findFreeSlots(events: Busy[], now: Date, tz: string, opts: SlotOptions): { start: Date; end: Date }[] {
  const { durationMin, count = 3, days = 7, workStart = 9 * 60, workEnd = 18 * 60, bufferMin = 15, noticeMin = 120 } = opts;
  const step = 30 * 60_000;
  const busy = events.map((e) => [Date.parse(e.starts_at) - bufferMin * 60_000, Date.parse(e.ends_at) + bufferMin * 60_000] as const);
  const earliest = now.getTime() + noticeMin * 60_000;
  const slots: { start: Date; end: Date }[] = [];
  for (let i = 0; i <= days && slots.length < count; i++) {
    const day = localDate(new Date(now.getTime() + i * 86_400_000), tz);
    if (day.weekday === 0 || day.weekday === 6) continue;
    const open = zonedToUtc(day, workStart, tz).getTime();
    const close = zonedToUtc(day, workEnd, tz).getTime();
    // First fit of the day, on the half hour.
    for (let t = Math.max(open, Math.ceil(earliest / step) * step); t + durationMin * 60_000 <= close; t += step) {
      const end = t + durationMin * 60_000;
      if (busy.some(([b0, b1]) => t < b1 && end > b0)) continue;
      slots.push({ start: new Date(t), end: new Date(end) });
      break;
    }
  }
  return slots;
}

/** "I work 9:00-17:30" (or 9h–18h) in the user's About-me facts sets working hours. */
export function workingHoursFromFacts(facts: string[]): { workStart: number; workEnd: number } | null {
  for (const f of facts) {
    if (!/\bwork/i.test(f)) continue;
    const m = f.match(/(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)?/i);
    if (!m) continue;
    const toMin = (h: string, min: string | undefined, ap: string | undefined) => ((+h % 12) + (ap?.toLowerCase() === "pm" ? 12 : ap ? 0 : +h >= 12 ? 12 : 0)) * 60 + (min ? +min : 0);
    const workStart = toMin(m[1], m[2], m[3]);
    const workEnd = toMin(m[4], m[5], m[6] ?? (+m[4] < +m[1] ? "pm" : undefined));
    if (workEnd > workStart && workEnd - workStart >= 60) return { workStart, workEnd };
  }
  return null;
}

export function formatSlots(slots: { start: Date; end: Date }[], tz: string): string[] {
  const day = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
  const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  return slots.map((s) => `${day(s.start)}, ${time(s.start)}–${time(s.end)}`);
}
