import { describe, expect, it } from "vitest";
import { parseBriefing } from "@/components/BriefingView";

const BODY = `**Weather**
- Barcelona, Spain: today overcast, 17–27°C; tomorrow fog — Weather data by Open-Meteo.com (CC BY 4.0)

**Agenda**
- Nothing today

**Still no answer**
- Re: quote for the shelves — to Priya Shah <priya@example.com>, 23 days ago
- Photos? — to Tom, 4 days ago

**Tech news**
- An example headline (Example Site (front page))
- Another one (Other (front page))

**Links**
- https://example.com/a
- https://example.org/b`;

describe("the briefing as cards", () => {
  const s = parseBriefing(BODY);
  it("makes one section per heading and drops the raw links list", () => {
    expect(s.map((x) => x.title)).toEqual(["Weather", "Agenda", "Still no answer", "Tech news"]);
  });
  it("splits title, detail and age, and removes raw addresses", () => {
    expect(s[2].items[0]).toEqual({ title: "Re: quote for the shelves", detail: "to Priya Shah", age: 23, source: undefined });
    expect(s[2].items[1]).toMatchObject({ title: "Photos?", detail: "to Tom", age: 4 });
    expect(s[0].items[0]).toMatchObject({ title: expect.stringContaining("Barcelona"), detail: "Weather data by Open-Meteo.com (CC BY 4.0)" });
  });
  it("marks empty sections and attaches each link to its news item", () => {
    expect(s[1].items[0]).toMatchObject({ empty: true });
    expect(s[3].items.map((i) => [i.title, i.source, i.href])).toEqual([
      ["An example headline", "Example Site", "https://example.com/a"],
      ["Another one", "Other", "https://example.org/b"],
    ]);
  });
  it("keeps plain text and never invents items from it", () => {
    expect(parseBriefing("Good morning. Two things today.")).toEqual([{ title: "", items: [], note: "Good morning. Two things today." }]);
  });
});
