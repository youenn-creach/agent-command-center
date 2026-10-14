import { getSetting, setSetting, type Ctx } from "./db";

/**
 * How "add event: …" ends up in your calendar:
 *  - "app": the app creates it in its own Google calendar after you approve (one click);
 *  - "link": you add it yourself on Google's pre-filled page (the app writes nothing).
 * Defaults to "app"; without the app calendar connected it falls back to the link.
 */
export type CalendarMode = "app" | "link";

export function calendarMode(ctx: Ctx): CalendarMode {
  return getSetting(ctx.db, "calendar.mode") === "link" ? "link" : "app";
}

export function setCalendarMode(ctx: Ctx, mode: CalendarMode) {
  setSetting(ctx.db, "calendar.mode", mode);
}
