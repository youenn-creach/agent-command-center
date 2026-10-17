import { describe, expect, it } from "vitest";
import { splitAsks } from "@/server/agents/command";
import { quickRoute } from "@/server/agents/assistant";

describe("splitAsks (two asks in one request)", () => {
  it("splits two requests joined by 'and'", () => {
    expect(splitAsks("what's my day like tomorrow and is it going to rain")).toEqual(["what's my day like tomorrow", "is it going to rain"]);
    expect(splitAsks("who am I waiting on and chase the one that's been longest")).toEqual(["who am I waiting on", "chase the one that's been longest"]);
    expect(splitAsks("give me the short version of today and tell me if I'm double booked")?.[1]).toBe("tell me if I'm double booked");
  });
  it("splits before a person after a reminder, not inside a reminder's own text", () => {
    expect(splitAsks("remind me about the boiler inspection the day before and tell the landlord it works")).toEqual(["remind me about the boiler inspection the day before", "tell the landlord it works"]);
    expect(splitAsks("remind me to call mom and tell her happy birthday")).toBeNull();
    expect(splitAsks("remind me to buy milk and check the oven")).toBeNull();
  });
  it("names the person from the first half for a pronoun", () => {
    expect(splitAsks("add lunch with Priya on thursday at 1 and email her to confirm")).toEqual(["add lunch with Priya on thursday at 1", "email Priya to confirm"]);
  });
  it("leaves single requests and known chains alone", () => {
    expect(splitAsks("lunch with Sam and Priya on friday")).toBeNull();
    expect(splitAsks("reply to the landlord that Tuesday works and put it in my calendar")).toBeNull();
    expect(splitAsks("find the race in my email and add it to my calendar")).toBeNull();
    expect(splitAsks("what's on today and tomorrow")).toBeNull();
  });
});

describe("quick rules added after batch 3", () => {
  it("moving or cancelling an event is not supported, a reminder is not an event", () => {
    expect(quickRoute("move my dentist to next week")?.skill).toBe("unsupported");
    expect(quickRoute("cancel my lunch with Sam")?.skill).toBe("unsupported");
    expect(quickRoute("delete my reminders")).toBeNull();
  });
  it("'what should I do first today' is the priorities list, 'short version of today' the agenda", () => {
    expect(quickRoute("what should I do first today")?.skill).toBe("priorities");
    expect(quickRoute("give me the short version of today")?.skill).toBe("agenda");
  });
});

describe("chase the longest wait", () => {
  it("is a nudge to the oldest wait", () => {
    expect(quickRoute("chase the one that's been longest")).toEqual({ skill: "nudge", args: { who: "longest" } });
    expect(quickRoute("chase the bank about my card")).toBeNull();
  });
});
