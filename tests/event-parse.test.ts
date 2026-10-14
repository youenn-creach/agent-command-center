import { describe, expect, it } from "vitest";
import { parseEventRequest, type PreparedEvent } from "@/server/agents/eventParse";
import { classify } from "@/server/agents/command";

// Tuesday 13 October 2026, 10:00 in Paris (UTC+2, summer time).
const NOW = new Date("2026-10-13T08:00:00Z");
const TZ = "Europe/Paris";
const parse = (t: string) => {
  const r = parseEventRequest(t, NOW, TZ);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const brief = (e: PreparedEvent) => ({ title: e.title, start: e.start, end: e.end, location: e.location, allDay: e.allDay });

describe("calendar event requests", () => {
  it("reads a weekday, a 12-hour time and a trailing location", () => {
    expect(brief(parse("dentist tuesday 3pm at Riverside Dental"))).toEqual({ title: "Dentist", start: "2026-10-20T15:00", end: "2026-10-20T16:00", location: "Riverside Dental", allDay: false });
  });

  it("reads tomorrow, ranges and durations", () => {
    expect(brief(parse("lunch with Sam tomorrow 12:30-14:00"))).toMatchObject({ title: "Lunch with Sam", start: "2026-10-14T12:30", end: "2026-10-14T14:00" });
    expect(brief(parse("call mum friday 6-7pm"))).toMatchObject({ start: "2026-10-16T18:00", end: "2026-10-16T19:00" });
    expect(brief(parse("gym tomorrow 7am for 90 min"))).toMatchObject({ start: "2026-10-14T07:00", end: "2026-10-14T08:30" });
    expect(brief(parse("standup 9h30 for half an hour tomorrow"))).toMatchObject({ title: "Standup", start: "2026-10-14T09:30", end: "2026-10-14T10:00" });
  });

  it("reads explicit dates: day/month, month names, ISO; past dates roll to next year", () => {
    expect(parse("concert 24/10 20:00").start).toBe("2026-10-24T20:00");
    expect(parse("flight 2 november 06:40").start).toBe("2026-11-02T06:40");
    expect(parse("tax deadline on Mar 3").start).toBe("2027-03-03");
    expect(parse("review 2026-12-01 10:00").start).toBe("2026-12-01T10:00");
  });

  it("without a time, makes an all-day event; a bare time means its next occurrence", () => {
    const e = parse("mum's birthday 24 oct");
    expect(e.allDay).toBe(true);
    expect(e.title).toBe("Mum's birthday");
    expect(e.ics).toContain("DTSTART;VALUE=DATE:20261024");
    expect(e.ics).toContain("DTEND;VALUE=DATE:20261025");
    expect(parse("call the bank 9am").start).toBe("2026-10-14T09:00"); // 9:00 already passed today
    expect(parse("call the bank 4pm").start).toBe("2026-10-13T16:00");
  });

  it("converts to the right instant across the DST change and past midnight", () => {
    const winter = parse("meeting 2 november 10:00"); // Paris is UTC+1 after 25 October
    expect(winter.startsAt).toBe("2026-11-02T09:00:00.000Z");
    const late = parse("party saturday 11pm-1am");
    expect(late.end).toBe("2026-10-18T01:00");
  });

  it("builds a pre-filled Google Calendar link and a valid .ics, with no API involved", () => {
    const e = parse("dentist tuesday 3pm at Riverside Dental");
    const url = new URL(e.googleUrl);
    expect(url.host).toBe("calendar.google.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({ action: "TEMPLATE", text: "Dentist", dates: "20261020T150000/20261020T160000", ctz: TZ, location: "Riverside Dental" });
    expect(e.ics).toMatch(/BEGIN:VEVENT[\s\S]*DTSTART:20261020T130000Z[\s\S]*SUMMARY:Dentist[\s\S]*LOCATION:Riverside Dental/);
  });

  it("asks for what is missing, and rejects impossible dates", () => {
    expect(parseEventRequest("dentist", NOW, TZ)).toEqual({ error: expect.stringMatching(/When is it/) });
    expect(parseEventRequest("tomorrow 3pm", NOW, TZ)).toEqual({ error: expect.stringMatching(/What is the event/) });
    expect(parseEventRequest("party 31/02", NOW, TZ)).toEqual({ error: expect.stringMatching(/doesn't exist/) });
  });

  it("is reached from the command bar without tripping the refusal rules", () => {
    expect(classify("add event: pay rent friday")).toEqual({ intent: "event", query: "pay rent friday" });
    expect(classify("add lunch with Sam tomorrow noon to my calendar")).toEqual({ intent: "event", query: "lunch with Sam tomorrow noon" });
    expect(classify("calendar: dentist tuesday 3pm")).toMatchObject({ intent: "event" });
    expect(classify("what's on my calendar today?")).toMatchObject({ intent: "today" });
  });
});

describe("calendar event requests: edge cases", () => {
  it("a borrowed am/pm never puts the start after the end", () => {
    expect(brief(parse("lunch friday 11-1pm"))).toMatchObject({ start: "2026-10-16T11:00", end: "2026-10-16T13:00" });
    expect(brief(parse("workshop friday 9-5pm"))).toMatchObject({ start: "2026-10-16T09:00", end: "2026-10-16T17:00" });
    expect(brief(parse("party saturday 11pm-1am")).end).toBe("2026-10-18T01:00"); // explicit: overnight
    expect(parse("noon meeting 12pm tomorrow").start).toBe("2026-10-14T12:00");
  });

  it("handles month ends, leap years and the year rollover", () => {
    expect(parse("rent 31/10").start).toBe("2026-10-31");
    expect(parseEventRequest("rent 31/11", NOW, TZ)).toEqual({ error: expect.stringMatching(/doesn't exist/) });
    expect(parseEventRequest("party 29/02/2027", NOW, TZ)).toEqual({ error: expect.stringMatching(/doesn't exist/) });
    expect(parse("leap day 29/02/2028").start).toBe("2028-02-29");
    const dec30 = new Date("2026-12-30T10:00:00Z");
    const p = (t: string) => parseEventRequest(t, dec30, TZ) as PreparedEvent;
    expect(p("new year brunch 2 jan 11:00").start).toBe("2027-01-02T11:00");
    expect(p("call friday 10am").start).toBe("2027-01-01T10:00");
    expect(p("drinks tomorrow 7pm").start).toBe("2026-12-31T19:00");
  });

  it("is correct across both daylight-saving changes", () => {
    // Spring forward (29 March 2026): 02:30 doesn't exist in Paris; it lands an hour later, not an hour early.
    const march = new Date("2026-03-27T10:00:00Z");
    const spring = parseEventRequest("early train sunday 2:30am", march, TZ) as PreparedEvent;
    expect(new Date(spring.startsAt).getTime()).toBeGreaterThanOrEqual(Date.parse("2026-03-29T01:00:00Z"));
    // An hour-long event over the switch is 1 real hour.
    const over = parseEventRequest("night shift sunday 1am-4am", march, TZ) as PreparedEvent;
    expect((Date.parse(over.endsAt) - Date.parse(over.startsAt)) / 3_600_000).toBe(2);
    // Fall back (25 October 2026): times on either side keep their real offsets.
    const oct = parse("brunch sunday 11:00");
    expect(oct.startsAt).toBe("2026-10-18T09:00:00.000Z");
    expect(parse("call 26/10 11:00").startsAt).toBe("2026-10-26T10:00:00.000Z");
  });

  it("understands French", () => {
    expect(brief(parse("dîner chez Julien vendredi 20h"))).toEqual({ title: "Dîner", start: "2026-10-16T20:00", end: "2026-10-16T21:00", location: "chez Julien", allDay: false });
    expect(brief(parse("dentiste mardi prochain 15h30 à Riverside"))).toMatchObject({ title: "Dentiste", start: "2026-10-20T15:30", location: "Riverside" });
    expect(parse("réunion demain de 10h à 11h30").end).toBe("2026-10-14T11:30");
    expect(parse("anniversaire de Léa le 24 octobre").start).toBe("2026-10-24");
    expect(parse("vol pour Lisbonne 2 novembre 6h40").start).toBe("2026-11-02T06:40");
    expect(parse("sport dans 3 jours 7h pendant 45 min").end).toBe("2026-10-16T07:45");
    expect(parse("déjeuner ce mardi midi").start).toBe("2026-10-13T12:00");
    expect(parse("appel après-demain 9h").start).toBe("2026-10-15T09:00");
  });

  it("French Ctrl+K phrasing reaches the event parser", () => {
    expect(classify("ajoute un rdv : dentiste mardi 15h")).toEqual({ intent: "event", query: "dentiste mardi 15h" });
    expect(classify("rdv : coiffeur samedi 10h")).toMatchObject({ intent: "event" });
    expect(classify("nouvel événement: réunion demain 9h")).toMatchObject({ intent: "event" });
  });
});
