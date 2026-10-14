"use client";

import { useEffect, useRef, useState } from "react";
import type { CommandResult } from "@/server/agents/command";
import type { PreparedEvent } from "@/server/agents/eventParse";
import { post } from "./api";
import { Button, cx, Spinner } from "./ui";
import type { Go } from "./Dashboard";

const EXAMPLES = ["add event: dentist tuesday 3pm", "add my flights to my calendar", "brief me", "find Lisbon", "what's waiting for me?", "what's scheduled?", "weekly review", "draft follow-ups"];

/** "Ask your Chief of Staff" — Ctrl/Cmd+K. Rule-based routing to a fixed set of safe intents. */
export function CommandBar({ go, refresh }: { go: Go; refresh: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<CommandResult | { error: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key === "Escape") setResult(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The local model takes a while to read a request on a laptop: show that it's working, and for how long.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function ask(q: string) {
    if (!q.trim()) return;
    setResult(null);
    setElapsed(0);
    setBusy(true);
    try {
      setResult(await post<CommandResult>("/api/command", { text: q }));
      await refresh();
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative w-full max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <label htmlFor="cmd" className="sr-only">
          Ask your Chief of Staff
        </label>
        <input
          id="cmd"
          ref={input}
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask your Chief of Staff…  (Ctrl+K)"
          autoComplete="off"
          onFocus={() => {
            // Wake the local model while the user types (the server limits this to once a minute).
            void post("/api/command", { op: "warm" }).catch(() => {});
          }}
          // Commands mix languages and short forms ("rdv : …"): no red spell-check underlines.
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-panel px-3 py-1.5 pr-8 text-sm placeholder:text-muted focus:border-accent"
        />
        {busy && (
          <span className="absolute right-2.5 top-2 text-muted">
            <Spinner />
          </span>
        )}
      </form>
      {busy && !result && (
        <div role="status" className="absolute left-0 right-0 top-10 z-30 rounded-xl border border-line bg-panel p-3 text-sm shadow-xl">
          <p>Understanding your request with the local model… {elapsed > 0 && <span className="tabular-nums text-muted">{elapsed} s</span>}</p>
          <p className="mt-1 text-xs text-muted">This usually takes 10–40 seconds on this computer. Nothing is sent or changed without your approval.</p>
        </div>
      )}
      {result && (
        <div role="dialog" aria-label="Chief of Staff reply" className="absolute left-0 right-0 top-10 z-30 rounded-xl border border-line bg-panel p-3 text-sm shadow-xl">
          {"error" in result ? (
            <p className="text-danger">{result.error}</p>
          ) : (
            <>
              <p className={cx(result.intent === "refused" && "text-warn")}>{result.reply}</p>
              {result.items && result.items.length > 0 && (
                <ul className="mt-2 max-h-64 space-y-1.5 overflow-auto">
                  {result.items.map((it, i) => (
                    <li key={i} className="rounded-md bg-panel-2 px-2 py-1.5">
                      <p className="font-medium">{it.title}</p>
                      {it.detail && <p className="text-xs text-muted">{it.detail}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {result.event && <EventCard event={result.event} approval={result.approval} refresh={refresh} />}
              {result.events && result.events.length > 0 && (
                <div className="max-h-[60vh] overflow-auto" tabIndex={0} role="region" aria-label="Prepared events">
                  {result.events.map((e) => (
                    <EventCard key={`${e.event.title}-${e.event.start}`} event={e.event} approval={e.approval} refresh={refresh} />
                  ))}
                </div>
              )}
              {result.intent === "help" && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:text-ink" onClick={() => { setText(ex); void ask(ex); }}>
                      {ex}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            {"understood" in result && result.understood && <span className="mr-auto text-[11px] text-muted">Understood by {result.understood}</span>}
            {"intent" in result && result.section && (
              <Button onClick={() => { go(result.section!); setResult(null); }}>Open</Button>
            )}
            <Button variant="ghost" onClick={() => setResult(null)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A prepared event: the user adds it to their calendar themselves; the app never writes to it. */
function EventCard({ event, approval, refresh }: { event: PreparedEvent; approval?: CommandResult["approval"]; refresh: () => Promise<void> }) {
  const [state, setState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: false });
  // One click = approve this exact event (hash-bound, as in the Action Queue), then run it.
  const approveAndAdd = async () => {
    if (!approval) return;
    setState({ busy: true });
    try {
      await post("/api/actions", { op: "approve", id: approval.actionId, expectedHash: approval.hash });
      const done = await post<{ status: string; result: string | null }>("/api/actions", { op: "execute", id: approval.actionId });
      setState({ busy: false, ...(done.status === "executed" ? { done: `Added to your “${approval.calendar}” calendar.` } : { error: done.result ?? "It couldn't be added; see the Action Queue." }) });
    } catch (e) {
      setState({ busy: false, error: (e as Error).message });
    }
    await refresh();
  };
  const tz = event.timezone;
  const day = new Date(event.startsAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const download = () => {
    const url = URL.createObjectURL(new Blob([event.ics], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${event.title.replace(/[^\w -]+/g, "").slice(0, 40).trim() || "event"}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="mt-2 rounded-lg border border-line bg-panel-2 p-3">
      <p className="font-medium">{event.title}</p>
      <p className="text-xs text-muted">
        {day}
        {event.allDay ? " · all day" : ` · ${time(event.startsAt)}–${time(event.endsAt)}`}
        {event.location && ` · ${event.location}`}
      </p>
      {approval ? (
        <>
          {state.done ? (
            <p className="mt-2 text-xs text-ok" role="status">
              {state.done}
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="primary" busy={state.busy} onClick={approveAndAdd}>
                Approve and add to calendar
              </Button>
              <a className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:text-ink" href={event.googleUrl} target="_blank" rel="noopener noreferrer">
                Or add it myself in Google
              </a>
            </div>
          )}
          {state.error && (
            <p className="mt-2 text-xs text-danger" role="alert">
              {state.error}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            <a className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white dark:text-[#0c1018]" href={event.googleUrl} target="_blank" rel="noopener noreferrer">
              Add to Google Calendar
            </a>
            <Button onClick={download}>Download .ics</Button>
          </div>
          <p className="mt-2 text-[11px] text-muted">Opens Google Calendar with the event filled in; you can still change it there before saving.</p>
        </>
      )}
    </div>
  );
}
