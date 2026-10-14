import type { ReactNode } from "react";
import { Badge } from "./ui";

/**
 * The briefing as cards: one per section, one row per item, instead of one block of text. The briefing's
 * text format stays as it is (bold titles and "- " bullets); this only reads it. Nothing is rendered as
 * HTML, and only https links become links.
 */

export interface BriefingItem {
  title: string;
  detail?: string;
  age?: number;
  source?: string;
  href?: string;
  empty?: boolean;
}
export interface BriefingSection {
  title: string;
  items: BriefingItem[];
  note?: string;
}

const EMPTY = /^(nothing|none|no |nobody)/i;

/** "- Re: quote — to Priya, 23 days ago" → title "Re: quote", detail "to Priya", age 23. */
function parseItem(raw: string): BriefingItem {
  let text = raw.replace(/\s*<[^<>\s]*@[^<>\s]*>/g, "").replace(/\s+/g, " ").trim();
  if (EMPTY.test(text)) return { title: text, empty: true };
  const age = text.match(/,?\s*(\d+) days? ago$/);
  if (age) text = text.slice(0, age.index).trim();
  const source = text.match(/\s\(([^()]+(?:\([^()]*\))?[^()]*)\)$/);
  let src: string | undefined;
  if (source && /\(front page\)/.test(source[0])) {
    src = source[1].replace(/\s*\(front page\)\s*$/, "").trim();
    text = text.slice(0, source.index).trim();
  }
  const dash = text.indexOf(" — ");
  const title = dash > 0 ? text.slice(0, dash) : text;
  const detail = dash > 0 ? text.slice(dash + 3) : undefined;
  return { title, detail, age: age ? Number(age[1]) : undefined, source: src };
}

export function parseBriefing(body: string): BriefingSection[] {
  const sections: BriefingSection[] = [];
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const heading = lines[0].match(/^\*\*(.+)\*\*$/);
    const rest = heading ? lines.slice(1) : lines;
    const title = heading?.[1] ?? "";
    const bullets = rest.filter((l) => /^\s*[-*•]\s+/.test(l)).map((l) => l.replace(/^\s*[-*•]\s+/, ""));
    const plain = rest.filter((l) => !/^\s*[-*•]\s+/.test(l)).join(" ");
    if (/^links$/i.test(title)) {
      // The links belong to the news items above, in the same order: attach them, don't list raw URLs.
      const news = sections.find((s) => /news/i.test(s.title));
      const urls = bullets.filter((u) => /^https:\/\/\S+$/.test(u));
      if (news && urls.length) {
        news.items.forEach((it, i) => {
          if (urls[i]) it.href = urls[i];
        });
        continue;
      }
    }
    sections.push({ title, items: bullets.map(parseItem), note: plain || undefined });
  }
  return sections;
}

const ICONS: [RegExp, string][] = [
  [/weather/i, "☀"],
  [/agenda|calendar|today|schedule/i, "📅"],
  [/waiting on you|reply|need/i, "✉"],
  [/no answer|waiting|follow/i, "⏳"],
  [/news/i, "📰"],
  [/remind|to-?do/i, "✔"],
  [/trip|travel|flight/i, "✈"],
];
const icon = (title: string) => ICONS.find(([re]) => re.test(title))?.[1] ?? "•";

function Row({ item }: { item: BriefingItem }): ReactNode {
  if (item.empty) {
    return (
      <li className="flex items-center gap-2 py-2 text-sm text-muted">
        <span aria-hidden>✓</span>
        {item.title}
      </li>
    );
  }
  const title = item.href?.startsWith("https://") ? (
    <a href={item.href} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-accent">
      {item.title}
    </a>
  ) : (
    <span className="font-medium">{item.title}</span>
  );
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm leading-snug">{title}</span>
        {(item.detail || item.source) && (
          <span className="mt-0.5 block break-words text-xs text-muted">
            {item.source && <span className="mr-1.5 rounded bg-panel-2 px-1.5 py-0.5 text-[11px]">{item.source}</span>}
            {item.detail}
          </span>
        )}
      </span>
      {item.age !== undefined && (
        <Badge tone={item.age >= 14 ? "warn" : "neutral"} className="shrink-0" title="Time since your last message">
          {item.age} days
        </Badge>
      )}
    </li>
  );
}

export function BriefingView({ body }: { body: string }) {
  const sections = parseBriefing(body);
  return (
    <div className="space-y-3">
      {sections.map((s, i) => (
        <section key={`${s.title}-${i}`} className="rounded-xl border border-line bg-panel-2/40 px-3.5 py-2.5">
          {s.title && (
            <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              <span aria-hidden className="text-sm normal-case">{icon(s.title)}</span>
              {s.title}
              {s.items.filter((it) => !it.empty).length > 1 && <span className="rounded-full bg-panel px-1.5 text-[11px] font-medium normal-case tabular-nums">{s.items.length}</span>}
            </h4>
          )}
          {s.note && <p className="mt-1.5 text-sm leading-relaxed">{s.note}</p>}
          {s.items.length > 0 && (
            <ul className="mt-1 divide-y divide-line">
              {s.items.map((it, j) => (
                <Row key={j} item={it} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
