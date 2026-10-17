import { describe, expect, it } from "vitest";
import { correctRoute } from "@/server/agents/command";

const pick = (text: string, skill: Parameters<typeof correctRoute>[1]["skill"]) => correctRoute(text, { skill, args: {} }).skill;

describe("correctRoute (safety nets after the model's pick)", () => {
  it("a reply without a calendar ask is a plain reply", () => {
    expect(pick("tell Laura yes for dinner on Saturday", "reply_and_add")).toBe("draft_reply");
    expect(pick("reply to Ana that Thursday works for me and add it to my calendar", "reply_and_add")).toBe("reply_and_add");
  });
  it("a reminder to someone else is a nudge, a reminder for the user stays", () => {
    expect(pick("send a reminder to Tom about the photos", "reminder_from_email")).toBe("nudge");
    expect(pick("remind me to chase Laura on Monday", "reminder")).toBe("reminder");
  });
  it("coming-up questions are the agenda, flights plus weather is the trip forecast", () => {
    expect(pick("what's coming up this week", "inbox_review")).toBe("agenda");
    expect(pick("my next flight and the weather there", "trips")).toBe("trip_weather");
  });
  it("leaves a correct pick alone", () => {
    expect(pick("did I miss anything important in my inbox?", "inbox_review")).toBe("inbox_review");
  });
});
