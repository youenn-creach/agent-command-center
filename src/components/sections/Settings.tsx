"use client";

import { useState } from "react";
import type { SectionProps } from "../Dashboard";
import { Badge, Button, Card, Field, inputCls, SectionHeader, useToast } from "../ui";
import { post, relative } from "../api";
import { ModelIcon, ServiceIcon, StatusLight } from "../icons";

const GB = 1024 ** 3;

export function SettingsView({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState({ name: "", url: "" });

  async function act<T>(key: string, path: string, body: unknown, ok: (r: T) => string) {
    setBusy(key);
    try {
      const r = await post<T>(path, body);
      toast(ok(r), "ok");
      await refresh();
      return r;
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  const models = [...state.health.ollama.models].sort((a, b) => a.sizeBytes - b.sizeBytes);

  return (
    <div>
      <SectionHeader title="Settings" description="Local runtime choices. Nothing here downloads models or contacts a service on its own." />
      <Card className="mb-4" title="Display">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={state.ui.simple}
            disabled={busy !== null}
            onChange={(e) => act("ui-simple", "/api/settings", { op: "ui-simple", value: e.target.checked }, () => (e.target.checked ? "Simple view on" : "Technical details shown"))}
          />
          <span>
            <span className="font-medium">Simple view</span>
            <span className="block text-xs text-muted">Hides technical details (model names, traces, scopes, fingerprints, the “Under the hood” page) and keeps what you need day to day. Safety checks are unchanged.</span>
          </span>
        </label>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Local language models"
          actions={
            <>
              <Button
                busy={busy === "offload-when-idle"}
                disabled={busy !== null || state.llm.offloadPending}
                title="Frees the memory as soon as nothing is using a model. Running tasks finish normally."
                onClick={() =>
                  act<{ unloaded: string[]; waitingFor: number }>("offload-when-idle", "/api/settings", { op: "offload", mode: "when-idle" }, (r) =>
                    r.waitingFor ? `Will free memory when ${r.waitingFor} running task(s) finish` : r.unloaded.length ? `Freed ${r.unloaded.join(", ")}` : "No model was loaded",
                  )
                }
              >
                {state.llm.offloadPending ? "Offload queued…" : "Offload when idle"}
              </Button>
              <Button
                variant="danger"
                busy={busy === "offload-now"}
                disabled={busy !== null}
                title="Frees the memory now. A task that is writing stops and uses its plain fallback text instead."
                onClick={() => act<{ unloaded: string[] }>("offload-now", "/api/settings", { op: "offload", mode: "now" }, (r) => (r.unloaded.length ? `Freed ${r.unloaded.join(", ")}` : "No model was loaded"))}
              >
                Offload now
              </Button>
            </>
          }
          subtitle="Pick one model per task. Only installed models are listed; it never receives tools, and there is no hosted fallback. Offloading frees RAM; the next task reloads the model (a few seconds)."
        >
          {!state.health.ollama.running ? (
            <p className="text-sm text-warn">Ollama is not running. Start it with ollama serve.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-1 font-medium">Model</th>
                    <th className="px-2 text-center font-medium" title="Briefings and Gmail reply drafts: nobody waits, quality wins">
                      Background
                    </th>
                    <th className="px-2 text-center font-medium" title="Search answers: you wait, speed wins">
                      Interactive
                    </th>
                    <th className="font-medium">Speed</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const heavy = m.sizeBytes > 4.5 * GB;
                    const sp = state.llm.speeds[m.name];
                    return (
                      <tr key={m.name} className="border-t border-line align-middle">
                        <td className="py-2 pr-2">
                          <span className="flex max-w-[13rem] items-center gap-1.5 font-medium" title={m.name}>
                            <ModelIcon model={m.name} size={14} thinking={state.llm.active.some((c) => c.model === m.name)} />
                            <span className="truncate">{m.name}</span>
                          </span>
                          <span className="block text-[11px] text-muted">
                            {m.parameterSize ?? "?"} · {(m.sizeBytes / GB).toFixed(1)} GB
                          </span>
                          {heavy && (
                            <Badge tone="warn" className="mt-1">
                              heavy for a CPU-only laptop
                            </Badge>
                          )}
                        </td>
                        {(["background", "interactive"] as const).map((task) => (
                          <td key={task} className="px-2 text-center">
                            <input
                              type="radio"
                              name={`model-${task}`}
                              aria-label={`Use ${m.name} for ${task} tasks`}
                              checked={state.llm[task] === m.name}
                              disabled={busy !== null}
                              onChange={() => act(`model-${task}`, "/api/settings", { op: "select-model", model: m.name, task }, () => `${m.name} now used for ${task} tasks`)}
                            />
                          </td>
                        ))}
                        <td className="text-[11px] text-muted">
                          {sp ? `${sp.outputTokensPerSec ?? "?"} tok/s` : "—"}
                          <button
                            className="ml-2 underline hover:text-ink disabled:opacity-50"
                            disabled={busy !== null}
                            onClick={() => act<{ outputTokensPerSec: number | null }>(`speed-${m.name}`, "/api/settings", { op: "speed-test", model: m.name }, (r) => `${m.name}: ${r.outputTokensPerSec ?? "?"} tokens/s`)}
                          >
                            {busy === `speed-${m.name}` ? "testing…" : "test"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.health.ollama.running && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-xs font-medium">Reply drafts by language</p>
              <p className="text-[11px] text-muted">The email&apos;s language is detected; a language can use its own model (e.g. a Catalan-trained one). Otherwise the background model writes it.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {state.llm.byLanguage.map((l) => (
                  <label key={l.lang} className="flex items-center justify-between gap-2 text-xs">
                    <span>{l.name}</span>
                    <select
                      className="max-w-[12rem] rounded-md border border-line bg-panel px-1 py-0.5"
                      value={l.model ?? ""}
                      disabled={busy !== null}
                      onChange={(e) =>
                        act(`lang-${l.lang}`, "/api/settings", { op: "language-model", lang: l.lang, model: e.target.value || null }, () =>
                          e.target.value ? `${l.name} drafts: ${e.target.value}` : `${l.name} drafts: background model`,
                        )
                      }
                    >
                      <option value="">Background model</option>
                      {models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name.split("/").at(-1)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Background = briefings and Gmail reply drafts (quality matters, they run while you do something else). Interactive = search answers (you wait for them). Only one model is in memory at a time. On a CPU-only laptop a ~1B model writes roughly 2–3× faster than a 3B one. To add one, run it yourself, for example <code>ollama pull gemma3:1b</code>.
          </p>
        </Card>

        <Card
          title="News sources"
          subtitle="Public https feeds for the morning briefing. Suggestions start switched off; nothing is fetched until you enable a source."
          actions={
            <Button busy={busy === "refresh"} disabled={!state.news.sources.some((s) => s.enabled)} onClick={() => act<{ report: { ok: boolean; items: number }[] }>("refresh", "/api/news", { op: "refresh" }, (r) => `Fetched ${r.report.reduce((n, x) => n + x.items, 0)} items from ${r.report.filter((x) => x.ok).length}/${r.report.length} sources`)}>
              Refresh now
            </Button>
          }
        >
          <ul className="divide-y divide-line">
            {state.news.sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <ServiceIcon id="public-news" size={16} className="text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-muted">{s.url}</span>
                  {s.last_fetch_at && (
                    <span className={`block text-[11px] ${s.last_status === "ok" ? "text-muted" : "text-danger"}`}>
                      {s.last_status === "ok" ? `${s.item_count} items` : s.last_status} · fetched {relative(s.last_fetch_at)}
                    </span>
                  )}
                </span>
                <StatusLight state={s.enabled ? (s.last_status && s.last_status !== "ok" ? "revoked" : "active") : "off"} label={s.enabled ? (s.last_status && s.last_status !== "ok" ? "Error" : "On") : "Off"} compact />
                <Button busy={busy === `t-${s.id}`} onClick={() => act(`t-${s.id}`, "/api/news", { op: "toggle", id: s.id, enabled: !s.enabled }, () => (s.enabled ? `${s.name} disabled` : `${s.name} enabled — click Refresh now`))}>
                  {s.enabled ? "Disable" : "Enable"}
                </Button>
                <Button variant="ghost" busy={busy === `r-${s.id}`} onClick={() => act(`r-${s.id}`, "/api/news", { op: "remove", id: s.id }, () => "Removed")}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act("add", "/api/news", { op: "add", ...source }, () => "Source added and enabled")) setSource({ name: "", url: "" });
            }}
          >
            <Field label="Name">
              <input className={inputCls} value={source.name} maxLength={80} onChange={(e) => setSource({ ...source, name: e.target.value })} />
            </Field>
            <Field label="Feed URL (https)">
              <input className={inputCls} value={source.url} maxLength={500} placeholder="https://example.com/feed.xml" onChange={(e) => setSource({ ...source, url: e.target.value })} />
            </Field>
            <Button type="submit" variant="primary" busy={busy === "add"} disabled={!source.name.trim() || !source.url.trim()}>
              Add
            </Button>
          </form>
          <p className="mt-2 text-[11px] text-muted">
            {state.news.liveItems > 0 ? `${state.news.liveItems} live items stored. The briefing uses them instead of the sample feed.` : "No live items yet — the briefing uses the sample feed and says so."} Feeds are fetched over https only, private network addresses are refused, and feed text is treated as untrusted data.
          </p>
        </Card>

        <AutomationsCard state={state} refresh={refresh} />

        <CalendarModeCard state={state} refresh={refresh} />
        <CloudRouterCard state={state} refresh={refresh} />

        <NotificationsCard state={state} refresh={refresh} />
        <WeatherCard state={state} refresh={refresh} />

        <RetentionCard state={state} refresh={refresh} />

        <Card title="Scheduler worker" subtitle="Schedules fire only while the worker runs.">
          <p className="flex items-center gap-2 text-sm">
            <StatusLight state={state.worker.running ? "active" : "idle"} label={state.worker.running ? "Running" : state.worker.lastHeartbeat ? `Not running · last seen ${relative(state.worker.lastHeartbeat)}` : "Not running"} />
          </p>
          <ul className="mt-3 space-y-1.5 text-xs text-muted">
            <li>
              Run it in a terminal: <code>npm run worker</code>
            </li>
            <li>
              Or start it automatically with your session: <code>npm run worker:install</code> (a systemd user service; remove it with <code>npm run worker:uninstall</code>).
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

const RETENTION_FIELDS = [
  ["activityDays", "Activity log"],
  ["searchHistoryDays", "Search history"],
  ["completedRemindersDays", "Completed reminders"],
  ["briefingsDays", "Old briefings (the latest is always kept)"],
] as const;

function RetentionCard({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [value, setValue] = useState(state.retention);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Data retention" subtitle="How long the dashboard keeps its own history. 0 = keep forever. Applied hourly by the worker.">
      <div className="grid gap-2 sm:grid-cols-2">
        {RETENTION_FIELDS.map(([key, label]) => (
          <Field key={key} label={`${label} (days)`}>
            <input type="number" min={0} max={3650} className={inputCls} value={value[key]} onChange={(e) => setValue({ ...value, [key]: Math.max(0, Math.min(3650, Number(e.target.value) || 0)) })} />
          </Field>
        ))}
      </div>
      <Button
        className="mt-3"
        variant="primary"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await post<{ removed: Record<string, number> }>("/api/settings", { op: "retention", value });
            const n = Object.values(r.removed).reduce((a, b) => a + b, 0);
            toast(`Saved. ${n} old item(s) removed now.`, "ok");
            await refresh();
          } catch (e) {
            toast((e as Error).message, "danger");
          } finally {
            setBusy(false);
          }
        }}
      >
        Save and apply
      </Button>
    </Card>
  );
}

/** User-registered webhooks (Zapier, Make, n8n, IFTTT…). URLs are secrets: sent once, never shown again. */
function AutomationsCard({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", description: "", url: "" });
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, body: unknown, ok: string) {
    setBusy(key);
    try {
      await post("/api/webhooks", body);
      toast(ok, "ok");
      await refresh();
      return true;
    } catch (e) {
      toast((e as Error).message, "danger");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Automations (webhooks)"
      subtitle="Connect agents to Zapier, Make, n8n, IFTTT… via a catch-hook URL. Agents can only propose a call; each one waits for your approval of the exact JSON."
    >
      {state.webhooks.length > 0 && (
        <ul className="mb-3 divide-y divide-line">
          {state.webhooks.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <ServiceIcon id={h.id} size={16} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{h.name}</span>
                <span className="block text-xs text-muted">
                  {h.host} · fingerprint {h.url_fingerprint.slice(0, 8)}
                  {h.last_called_at ? ` · last call ${relative(h.last_called_at)} (${h.last_status})` : " · never called"}
                </span>
              </span>
              <Button variant="ghost" busy={busy === h.id} onClick={() => confirm(`Remove "${h.name}"? Pending proposals for it are cancelled.`) && act(h.id, { op: "remove", id: h.id }, "Webhook removed")}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act("add", { op: "add", input: form }, "Webhook added. Grant access in Connections & Permissions to use it.")) setForm({ name: "", description: "", url: "" });
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name (used in “trigger <name>: …”)">
            <input className={inputCls} value={form.name} maxLength={60} placeholder="Todoist" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="What it does (shown when approving)">
            <input className={inputCls} value={form.description} maxLength={200} placeholder="Adds a task to my Inbox project" onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <Field label="Webhook URL (https; stored encrypted, never shown again)">
          <input className={inputCls} type="password" autoComplete="off" value={form.url} maxLength={1000} placeholder="https://hooks.zapier.com/hooks/catch/…" onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={busy === "add"} disabled={form.name.trim().length < 2 || !form.url.trim()}>
            Add webhook
          </Button>
        </div>
      </form>
      <p className="mt-2 text-[11px] text-muted">
        Each webhook becomes its own service with access None. To use one: give the service <em>Write with approval</em>, give the Follow-up agent <em>Write with approval</em> on it, then ask “trigger Todoist: buy milk”. The JSON sent is <code>{"{ text, _meta }"}</code> plus an <code>Idempotency-Key</code> header.
      </p>
    </Card>
  );
}

type Loc = NonNullable<SectionProps["state"]["weather"]["location"]>;

/** City-level weather for the briefing (Open-Meteo, no account). */
function WeatherCard({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Loc[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loc = state.weather.location;
  const svc = state.services.find((s) => s.id === "weather");

  async function call<T>(key: string, body: unknown) {
    setBusy(key);
    try {
      return await post<T>("/api/weather", body);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Weather" subtitle="A forecast line in the morning briefing. Only a city-level location is sent to Open-Meteo; no account needed.">
      {loc ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ServiceIcon id="weather" size={18} />
          <span className="flex-1">
            {loc.name}
            {loc.admin1 ? `, ${loc.admin1}` : ""}
            {loc.country ? `, ${loc.country}` : ""}
          </span>
          {svc && <StatusLight state={svc.access_level === "none" ? "idle" : "active"} label={svc.access_level === "none" ? "Set · grant Read to use" : "In use"} compact />}
          <Button variant="ghost" busy={busy === "clear"} onClick={async () => { if (await call("clear", { op: "clear" })) { toast("Weather location removed", "ok"); await refresh(); } }}>
            Remove
          </Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await call<{ results: Loc[] }>("search", { op: "search", query });
            if (r) setResults(r.results);
          }}
        >
          <label className="sr-only" htmlFor="wx">
            City
          </label>
          <input id="wx" className={inputCls} value={query} maxLength={80} placeholder="City, e.g. Madrid" onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" busy={busy === "search"} disabled={query.trim().length < 2}>
            Search
          </Button>
        </form>
      )}
      {!loc && results && (
        <ul className="mt-2 space-y-1">
          {results.length === 0 && <li className="text-xs text-muted">No match.</li>}
          {results.map((r) => (
            <li key={`${r.latitude},${r.longitude}`}>
              <button
                className="w-full rounded-md border border-line px-2 py-1.5 text-left text-sm hover:bg-panel-2"
                onClick={async () => {
                  if (await call("set", { op: "set", location: r })) {
                    toast(`Weather set to ${r.name}. Grant Read to the Weather service and the Calendar agent to include it in briefings.`, "ok");
                    setResults(null);
                    await refresh();
                  }
                }}
              >
                {r.name}
                <span className="text-xs text-muted">
                  {r.admin1 ? ` · ${r.admin1}` : ""}
                  {r.country ? ` · ${r.country}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted">Weather data by Open-Meteo.com (CC BY 4.0). Coordinates are rounded to about 1 km.</p>
    </Card>
  );
}

/** Desktop notifications and optional phone push (ntfy). Off by default. */
function NotificationsCard({ state, refresh }: SectionProps) {
  const toast = useToast();
  const n = state.notifications;
  const [busy, setBusy] = useState<string | null>(null);
  const [topic, setTopic] = useState("");

  async function save(patch: Partial<{ desktop: boolean; details: boolean; kinds: string[]; ntfyUrl: string | null }>, ok: string) {
    setBusy("save");
    try {
      await post("/api/settings", { op: "notify-settings", value: { desktop: n.desktop, details: n.details, kinds: n.kinds, ...patch } });
      toast(ok, "ok");
      await refresh();
      return true;
    } catch (e) {
      toast((e as Error).message, "danger");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Notifications"
      subtitle="Let the assistant reach you first. Each event notifies once, at most 12 an hour."
      actions={
        <Button
          busy={busy === "test"}
          disabled={busy !== null || (!n.desktop && !n.ntfyHost)}
          onClick={async () => {
            setBusy("test");
            try {
              const r = await post<{ desktop: boolean; push: boolean }>("/api/settings", { op: "notify-test" });
              toast(`Test sent${r.desktop ? " · desktop" : ""}${r.push ? " · phone" : ""}`, "ok");
            } catch (e) {
              toast((e as Error).message, "danger");
            } finally {
              setBusy(null);
            }
          }}
        >
          Send a test
        </Button>
      }
    >
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={n.desktop} disabled={busy !== null} onChange={(e) => save({ desktop: e.target.checked }, e.target.checked ? "Desktop notifications on" : "Desktop notifications off")} />
        <span>
          <span className="font-medium">Desktop notifications</span>
          <span className="block text-xs text-muted">Shown on this computer; may include a subject line.</span>
        </span>
      </label>

      <div className="mt-3 text-sm">
        <p className="font-medium">Phone (ntfy)</p>
        {n.ntfyHost ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            Sending to a private topic on <code>{n.ntfyHost}</code>
            <button className="text-danger underline" disabled={busy !== null} onClick={() => save({ ntfyUrl: null }, "Phone notifications removed")}>
              Remove
            </button>
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted">
              Install the free ntfy app, subscribe to a topic only you know, and paste its URL. The topic is stored encrypted. Anyone who knows it can read the pushes, so keep it random.
            </p>
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await save({ ntfyUrl: topic }, "Phone notifications on: send a test")) setTopic("");
              }}
            >
              <label className="sr-only" htmlFor="ntfy-topic">
                ntfy topic URL
              </label>
              <input id="ntfy-topic" className={`${inputCls} min-w-0 flex-1`} placeholder="https://ntfy.sh/your-private-topic" value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} />
              <Button type="button" variant="ghost" onClick={() => setTopic(`https://ntfy.sh/acc-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`)}>
                Generate a private topic
              </Button>
              <Button type="submit" busy={busy === "save"} disabled={!topic.trim()}>
                Save
              </Button>
            </form>
          </>
        )}
        <label className="mt-2 flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={n.details} disabled={busy !== null} onChange={(e) => save({ details: e.target.checked }, e.target.checked ? "Pushes include details" : "Pushes stay generic")} />
          <span>Include details (e.g. a subject line) in phone pushes. They pass through the ntfy server, so this is off by default.</span>
        </label>
      </div>

      <fieldset className="mt-3 text-sm">
        <legend className="font-medium">Notify me when</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {n.available.map((k) => (
            <label key={k.kind} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={n.kinds.includes(k.kind)}
                disabled={busy !== null}
                onChange={(e) => save({ kinds: e.target.checked ? [...n.kinds, k.kind] : n.kinds.filter((x) => x !== k.kind) }, "Saved")}
              />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}

/** Option a / option b for "add event: …": the app creates it after approval, or you add it in Google. */
function CalendarModeCard({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const app = state.services.find((s) => s.id === "google-calendar-app");
  const connected = app?.connection_state === "connected";
  const choose = async (mode: "app" | "link") => {
    setBusy(true);
    try {
      await post("/api/settings", { op: "calendar-mode", mode });
      toast(mode === "app" ? "The app will add events after your approval" : "You'll add events yourself in Google Calendar", "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Calendar events" subtitle="What happens when you ask “add event: dentist tuesday 3pm”.">
      <fieldset className="space-y-2 text-sm">
        <legend className="sr-only">Who adds the event</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="calendar-mode" className="mt-1" checked={state.calendar.mode === "app"} disabled={busy} onChange={() => choose("app")} />
          <span>
            <span className="font-medium">The app adds it, after you approve</span>
            <span className="block text-xs text-muted">
              One click in the Ctrl+K card. Events go to a separate “Agent Command Center” calendar, shown next to your own in Google Calendar. The app can&apos;t see or change your other calendars.
              {!connected && app && " Connect “Google Calendar: app calendar” in Connections & Permissions first; until then you get the link below."}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="calendar-mode" className="mt-1" checked={state.calendar.mode === "link"} disabled={busy} onChange={() => choose("link")} />
          <span>
            <span className="font-medium">I add it myself in Google Calendar</span>
            <span className="block text-xs text-muted">The app only fills in Google&apos;s new-event page; you click Save there. Nothing is written by the app.</span>
          </span>
        </label>
      </fieldset>
    </Card>
  );
}

/** Optional cloud help for understanding requests (Mistral API, free tier only). Off by default; the key is write-only. */
function CloudRouterCard({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const c = state.cloudRouter;
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await post("/api/settings", { op: "cloud-router", ...body });
      toast(done, "ok");
      setKey("");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Understanding requests (optional cloud help)" subtitle="Off by default. When on, Mistral’s API chooses which skill answers your request. Only the words you type in Ctrl+K and the list of skills are sent; your mail, notes, calendar and drafts never leave this computer.">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={c.enabled} disabled={busy || (!c.hasKey && !c.enabled)} onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? "Cloud help for understanding is on" : "Cloud help for understanding is off")} />
        <span>
          <span className="font-medium">Use the Mistral API to understand requests</span>
          <span className="block text-xs text-muted">
            {c.blocked && c.enabled ? `Not used right now: ${c.blocked}. The local model answers. ` : ""}
            {c.hasKey ? `Today: ${c.usedToday} of ${c.cap} requests.` : "Save a key first."}
          </span>
        </span>
      </label>
      <p className="mt-2 rounded-md bg-panel-2 px-2.5 py-2 text-xs text-muted">
        Free only: create a key on Mistral&apos;s free Experiment plan (console.mistral.ai) and add no payment method, so nothing can be billed. The app stops at {c.cap} requests a day and, on any rate-limit, quota or payment message from Mistral, goes back to the local model until the next day.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label={c.hasKey ? "Replace the API key" : "API key"}>
          <input type="password" autoComplete="off" className={inputCls} value={key} placeholder={c.hasKey ? "saved (hidden)" : "paste your key"} onChange={(e) => setKey(e.target.value.trim())} />
        </Field>
        <Button busy={busy} disabled={!key} onClick={() => save({ key }, "API key saved (sealed on this computer)")}>
          Save key
        </Button>
        {c.hasKey && (
          <Button variant="ghost" busy={busy} onClick={() => save({ key: "", enabled: false }, "API key removed")}>
            Remove key
          </Button>
        )}
        <Field label="Model">
          <select className={inputCls} value={c.model} disabled={busy} onChange={(e) => save({ model: e.target.value }, `Cloud model: ${e.target.value}`)}>
            <option value="mistral-small-latest">Mistral Small (recommended)</option>
            <option value="ministral-8b-latest">Ministral 8B</option>
            <option value="mistral-medium-latest">Mistral Medium</option>
          </select>
        </Field>
      </div>
    </Card>
  );
}
