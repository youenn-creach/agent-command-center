"use client";

import { useEffect, useRef, useState } from "react";
import type { CommandResult } from "@/server/agents/command";
import type { PreparedEvent } from "@/server/agents/eventParse";
import { post } from "./api";
import { Button, cx, Spinner } from "./ui";
import type { Go } from "./Dashboard";
import { CHOICES, choiceLabel } from "@/server/agents/choices";

/** The longest request accepted (the server checks the same limit). */
const MAX = 500;

const EXAMPLES = ["add event: dentist tuesday 3pm", "add my flights to my calendar", "brief me", "find Lisbon", "what's waiting for me?", "what's scheduled?", "weekly review", "draft follow-ups"];

/** "Ask your Chief of Staff" — Ctrl/Cmd+K. Rule-based routing to a fixed set of safe intents. */
export function CommandBar({ go, refresh }: { go: Go; refresh: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<CommandResult | { error: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  // The request the shown answer is for, and whether the "not right?" choices are open.
  const [askedText, setAskedText] = useState("");
  const [fixing, setFixing] = useState(false);

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

  // The field grows with the request (up to about six lines), so a long sentence can be read whole before it is sent.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  /** `chosen`: the kind of request the user picked under a previous answer ("not right?"); it runs that way and is remembered. */
  async function ask(q: string, chosen?: { skill: string; wrong?: string }) {
    if (!q.trim()) return;
    setResult(null);
    setFixing(false);
    setAskedText(q);
    setElapsed(0);
    setBusy(true);
    try {
      setResult(await post<CommandResult>("/api/command", chosen ? { text: q, skill: chosen.skill, wrong: chosen.wrong } : { text: q }));
      await refresh();
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    // Phones: the bar gets its own row under the header (it is the main way in); wider screens: inline.
    <div className="relative order-last w-full basis-full md:order-none md:max-w-2xl md:basis-auto">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <label htmlFor="cmd" className="sr-only">
          Ask your Chief of Staff
        </label>
        <div className="prompt-shell" data-busy={busy}>
          <div className="prompt-inner flex items-start gap-2 px-3 py-1.5">
            <Sparkle busy={busy} />
            <textarea
              id="cmd"
              ref={input}
              rows={1}
              value={text}
              maxLength={MAX}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter starts a new line (and Enter while an input method composes a word does neither).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(text);
                }
              }}
              placeholder="Ask or tell your Chief of Staff anything…"
              autoComplete="off"
              onFocus={() => {
                setFocused(true);
                // Wake the local model while the user types (the server limits this to once a minute).
                void post("/api/command", { op: "warm" }).catch(() => {});
              }}
              onBlur={() => setFocused(false)}
              // Commands mix languages and short forms ("rdv : …"): no red spell-check underlines.
              spellCheck={false}
              className="max-h-[168px] min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm leading-6 outline-none placeholder:text-muted"
            />
            <span className="flex h-7 shrink-0 items-center gap-1.5">
              {text.length > MAX - 60 && <span className="text-[11px] tabular-nums text-muted">{MAX - text.length}</span>}
              {busy ? (
                <span className="text-muted">
                  <Spinner />
                </span>
              ) : text.trim() ? (
                <button type="submit" aria-label="Send" title="Send (Enter) · new line: Shift+Enter" className="prompt-send grid h-7 w-7 place-items-center rounded-lg text-white">
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                  </svg>
                </button>
              ) : (
                !focused && <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 font-sans text-[10px] text-muted sm:inline">Ctrl K</kbd>
              )}
            </span>
          </div>
        </div>
      </form>
      {busy && !result && (
        <div role="status" className="absolute left-0 right-0 top-full z-30 mt-2 rounded-xl border border-line bg-panel p-3 text-sm shadow-xl">
          <p>
            <span className="shimmer-text">Understanding your request with the local model…</span> {elapsed > 0 && <span className="tabular-nums text-muted">{elapsed} s</span>}
          </p>
          <p className="mt-1 text-xs text-muted">This usually takes 10–40 seconds on this computer. Nothing is sent or changed without your approval.</p>
        </div>
      )}
      {result && (
        <div role="dialog" aria-label="Chief of Staff reply" className="absolute left-0 right-0 top-full z-30 mt-2 rounded-xl border border-line bg-panel p-3 text-sm shadow-xl">
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
          {"intent" in result && fixing && (
            <div className="mt-2 rounded-lg border border-line bg-panel-2 p-2">
              <p className="text-xs text-muted">What did you mean? I’ll do it that way and remember it for next time.</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {CHOICES.filter((c) => c.skill !== result.skill).map((c) => (
                  <button key={c.skill} className="rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] hover:border-accent hover:text-ink" onClick={() => void ask(askedText, { skill: c.skill, wrong: result.skill })}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            {"understood" in result && result.understood && (
              <span className="mr-auto text-[11px] text-muted">
                {choiceLabel(result.skill) ? <>Understood as “{choiceLabel(result.skill)}” · </> : null}
                {result.understood === "your choice" ? "your choice, remembered" : `by ${result.understood}`}
                {result.understood !== "your choice" && !result.asked && askedText && (
                  <>
                    {" · "}
                    <button className="underline decoration-dotted underline-offset-2 hover:text-ink" aria-expanded={fixing} onClick={() => setFixing((f) => !f)}>
                      Not right?
                    </button>
                  </>
                )}
              </span>
            )}
            {"intent" in result && result.auto && result.ref?.actionId && <UndoButton actionId={result.ref.actionId} refresh={refresh} />}
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

/** Undo right under an answer autopilot acted on (the same Undo as in "Done for you" on Today). */
function UndoButton({ actionId, refresh }: { actionId: string; refresh: () => Promise<void> }) {
  const [state, setState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: false });
  if (state.done) return <span className="text-xs text-ok" role="status">{state.done}</span>;
  return (
    <>
      {state.error && <span className="text-xs text-danger" role="alert">{state.error}</span>}
      <Button
        variant="ghost"
        busy={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const out = await post<{ summary: string }>("/api/actions", { op: "undo", type: "action", id: actionId });
            setState({ busy: false, done: out.summary });
            await refresh();
          } catch (e) {
            setState({ busy: false, error: (e as Error).message });
          }
        }}
      >
        Undo
      </Button>
    </>
  );
}

/** The prompt bar's mark: a small four-point star, gently pulsing while the assistant works. */
function Sparkle({ busy }: { busy: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden className={cx("mt-1 shrink-0", busy && "animate-pulse")}>
      <defs>
        <linearGradient id="prompt-spark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--voyage)" />
        </linearGradient>
      </defs>
      <path fill="url(#prompt-spark)" d="M10 1.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5Z" />
      <path fill="url(#prompt-spark)" opacity=".7" d="M15.5 12.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5Z" />
    </svg>
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
