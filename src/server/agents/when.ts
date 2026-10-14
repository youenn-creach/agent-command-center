import { localToday, normalizeDayWords, zonedToUtc, type Ymd } from "./eventParse";

/**
 * The period a question is about ("tomorrow", "this weekend", "next friday afternoon", "next week",
 * "on 20 December", "the next 3 days"), read with plain rules from the user's own words. The local
 * model only chooses *what* to do; dates are never left to it.
 */

export interface Range {
  from: Date;
  to: Date;
  /** Human label: "tomorrow (Thursday 15 October)". */
  label: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PARTS: Record<string, [number, number]> = { morning: [6, 12], afternoon: [12, 18], evening: [18, 24], tonight: [18, 24], night: [18, 24] };

const add = ({ y, m, d }: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const weekday = ({ y, m, d }: Ymd) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const fmt = (d: Ymd, tz: string) => zonedToUtc(d, 12 * 60, tz).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });

export function parseRange(text: string, now: Date, tz: string): Range {
  const t = normalizeDayWords(text).toLowerCase();
  const today = localToday(now, tz);
  const span = (start: Ymd, days: number, label: string, hours: [number, number] = [0, 24]): Range => ({
    from: zonedToUtc(start, hours[0] * 60, tz),
    to: zonedToUtc(add(start, days - 1), hours[1] * 60, tz),
    label,
  });
  const part = Object.keys(PARTS).find((p) => new RegExp(`\\b${p}\\b`).test(t));
  const hours = part ? PARTS[part] : undefined;
  const day = (d: Ymd, word: string) => {
    const when = `${word}${part && part !== "tonight" ? ` ${part}` : ""}`.trim();
    return span(d, 1, when ? `${when} (${fmt(d, tz)})` : `${fmt(d, tz)}${part ? ` ${part}` : ""}`, hours);
  };

  const n = t.match(/\b(?:next|coming|following)\s+(\d{1,2})\s+days?\b|\bin\s+the\s+next\s+(\d{1,2})\s+days?\b/);
  if (n) {
    const k = Math.min(+(n[1] ?? n[2]), 31);
    return span(today, k, `the next ${k} days`);
  }
  const inDays = t.match(/\bin\s+(\d{1,2})\s+days?\b/);
  if (inDays) return day(add(today, +inDays[1]), `in ${inDays[1]} days`);
  if (/\byesterday\b/.test(t)) return day(add(today, -1), "yesterday");
  if (/\b(day after tomorrow)\b/.test(t)) return day(add(today, 2), "the day after tomorrow");
  if (/\btomorrow\b/.test(t)) return day(add(today, 1), "tomorrow");
  if (/\b(this|the|next|coming)?\s*week-?end\b/.test(t)) {
    const toSat = (6 - weekday(today) + 7) % 7;
    const sat = /\bnext\b/.test(t) && toSat < 6 ? add(today, toSat + 7) : weekday(today) === 0 ? add(today, -1) : add(today, toSat);
    const start = weekday(today) === 0 && !/\bnext\b/.test(t) ? today : sat;
    return span(start, weekday(start) === 0 ? 1 : 2, `the weekend (${fmt(sat, tz)} and Sunday)`);
  }
  if (/\bnext\s+week\b/.test(t)) {
    const monday = add(today, ((8 - weekday(today)) % 7) || 7);
    return span(monday, 7, `next week (from ${fmt(monday, tz)})`);
  }
  if (/\b(this|the rest of the)\s+week\b/.test(t)) {
    const toSunday = (7 - weekday(today)) % 7;
    return span(today, toSunday + 1, "this week");
  }
  if (/\bnext\s+month\b/.test(t)) {
    const first = { y: today.m === 12 ? today.y + 1 : today.y, m: today.m === 12 ? 1 : today.m + 1, d: 1 };
    const days = new Date(Date.UTC(first.y, first.m, 0)).getUTCDate();
    return span(first, days, "next month");
  }
  if (/\bthis\s+month\b/.test(t)) {
    const days = new Date(Date.UTC(today.y, today.m, 0)).getUTCDate() - today.d + 1;
    return span(today, days, "the rest of this month");
  }
  const wd = t.match(/\b(next|this|on|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    let delta = (target - weekday(today) + 7) % 7;
    if (wd[1] === "next" && delta === 0) delta = 7;
    return day(add(today, delta), wd[1] === "next" ? `next ${wd[2]}` : wd[2]);
  }
  const date = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (date) {
    const d = +(date[1] ?? date[4]);
    const m = MONTHS.indexOf(date[2] ?? date[3]) + 1;
    let target = { y: today.y, m, d };
    if (target.m < today.m || (target.m === today.m && target.d < today.d)) target = { ...target, y: today.y + 1 };
    return day(target, "");
  }
  return day(today, part === "tonight" ? "tonight" : "today");
}
