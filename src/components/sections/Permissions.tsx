"use client";

import { useState } from "react";
import { LEVELS, LEVEL_LABEL, post, relative } from "../api";
import type { SectionProps } from "../Dashboard";
import { Badge, Button, Card, SectionHeader, useSimpleMode, useToast } from "../ui";
import { ServiceIcon, serviceLight, StatusLight } from "../icons";

/** One colour per level, so the matrix reads at a glance (the label is always shown too). */
const LEVEL_TONE: Record<string, string> = {
  none: "border-line bg-panel text-muted",
  read: "border-lvl-read/50 bg-lvl-read-soft text-lvl-read",
  prepare: "border-lvl-prepare/50 bg-lvl-prepare-soft text-lvl-prepare",
  write_with_approval: "border-lvl-write/50 bg-lvl-write-soft text-lvl-write",
};
const LEVEL_HELP: Record<string, string> = { none: "no access", read: "can look", prepare: "can draft, nothing leaves", write_with_approval: "can act after you approve each one" };
const LEVEL_TEXT: Record<string, string> = { none: "text-muted", read: "text-lvl-read", prepare: "text-lvl-prepare", write_with_approval: "text-lvl-write" };

export function PermissionsView({ state, refresh }: SectionProps) {
  const toast = useToast();
  const simple = useSimpleMode();
  const [busy, setBusy] = useState<string | null>(null);

  async function change(body: Record<string, unknown>, key: string, ok: string) {
    setBusy(key);
    try {
      await post("/api/permissions", body);
      toast(ok, "ok");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const levelsUpTo = (max: string) => LEVELS.filter((l) => LEVELS.indexOf(l) <= LEVELS.indexOf(max as (typeof LEVELS)[number]));

  return (
    <div>
      <SectionHeader
        title="Connections & Permissions"
        description={
          <>
            Effective access = the <strong>more restrictive</strong> of the service level and the agent level. The server enforces it on every tool call, approval, execution and scheduled run — this screen only edits the settings. Auto-act is designed but disabled in this version.
          </>
        }
      />
      <Card title="Services" subtitle="Demo services hold fictional data. Live connectors are listed but not implemented; they cannot be granted access.">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 font-medium">Service</th>
                <th className="font-medium">Connection</th>
                {!simple && <th className="font-medium">Scope</th>}
                <th className="font-medium">Service access</th>
                <th className="font-medium">
                  <span className="sr-only">Connection actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.services.map((s) => (
                <tr key={s.id} className="border-t border-line align-top">
                  <td className="py-2 pr-3">
                    <div className="flex gap-2.5">
                      <ServiceIcon id={s.id} size={22} className={s.kind === "demo" ? "mt-0.5 text-muted" : "mt-0.5"} />
                      <div>
                        <p className="font-medium">{s.name}</p>
                        <p className="text-xs text-muted">{s.description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col items-start gap-1">
                      <StatusLight {...serviceLight(s)} />
                      <Badge tone={s.kind === "demo" ? "warn" : "accent"}>{s.kind === "demo" ? "demo data" : "your account"}</Badge>
                      {s.last_sync_at && <span className="text-[11px] text-muted">synced {relative(s.last_sync_at)}</span>}
                    </div>
                  </td>
                  {!simple && <td className="py-2 pr-3 text-xs">{s.scopes.length ? s.scopes.map((sc) => <code key={sc} className="mr-1 block">{sc}</code>) : <span className="text-muted">none granted</span>}</td>}
                  <td className="py-2 pr-3">
                    <label className="sr-only" htmlFor={`svc-${s.id}`}>
                      Access level for {s.name}
                    </label>
                    <select
                      id={`svc-${s.id}`}
                      className={`rounded-lg border px-2 py-1 text-xs ${LEVEL_TONE[s.access_level] ?? LEVEL_TONE.none}`}
                      value={s.access_level}
                      disabled={busy !== null || s.connection_state !== "connected"}
                      onChange={(e) => change({ op: "service", serviceId: s.id, level: e.target.value }, `svc-${s.id}`, `${s.name}: ${LEVEL_LABEL[e.target.value]}`)}
                    >
                      {levelsUpTo(s.max_level).map((l) => (
                        <option key={l} value={l}>
                          {LEVEL_LABEL[l]}
                        </option>
                      ))}
                      <option value="auto_act" disabled>
                        Auto-act (disabled in MVP)
                      </option>
                    </select>
                    {s.access_level !== "none" && !state.matrix.some((row) => row.cells.some((c) => c.serviceId === s.id && c.effective !== "none")) && (
                      <span className="mt-1 block max-w-[12rem] text-[11px] text-warn">No agent can use this yet: grant one in Agent permissions below.</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {s.id === "gmail" || s.id === "google-calendar" || s.id === "gmail-drafts" || s.id === "google-calendar-app" ? (
                      <GoogleControls service={s} state={state} refresh={refresh} />
                    ) : s.kind === "real" ? (
                      // Weather and webhooks are set up in Settings; here they can only be revoked.
                      s.connection_state === "connected" ? (
                        <Button variant="danger" busy={busy === `dc-${s.id}`} onClick={() => change({ op: "disconnect", serviceId: s.id }, `dc-${s.id}`, `${s.name}: access revoked`)}>
                          Revoke
                        </Button>
                      ) : s.id.startsWith("hook-") ? (
                        <Button busy={busy === `rc-${s.id}`} onClick={() => change({ op: "reconnect", serviceId: s.id }, `rc-${s.id}`, `${s.name} re-enabled with access None`)}>
                          Re-enable
                        </Button>
                      ) : (
                        <span className="text-xs text-muted">Set up in Settings</span>
                      )
                    ) : s.connection_state === "connected" ? (
                      <Button variant="danger" busy={busy === `dc-${s.id}`} onClick={() => change({ op: "disconnect", serviceId: s.id }, `dc-${s.id}`, `${s.name} disconnected; access revoked`)}>
                        Disconnect &amp; revoke
                      </Button>
                    ) : s.kind === "demo" ? (
                      <Button busy={busy === `rc-${s.id}`} onClick={() => change({ op: "reconnect", serviceId: s.id }, `rc-${s.id}`, `${s.name} reconnected with access None`)}>
                        Reconnect
                      </Button>
                    ) : (
                      null
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-4" title="Agent permissions" subtitle="Pick what each agent may do on each service. The line underneath is what it can actually do right now: the lower of your choice and the service's own access above. A dash means the agent's role never uses that service.">
        <ul className="mb-3 flex flex-wrap gap-2 text-[11px]" aria-label="Access levels">
          {(["none", "read", "prepare", "write_with_approval"] as const).map((l) => (
            <li key={l} className={`rounded-md border px-1.5 py-0.5 ${LEVEL_TONE[l]}`} title={LEVEL_HELP[l]}>
              {LEVEL_LABEL[l]}
              <span className="text-muted"> · {LEVEL_HELP[l]}</span>
            </li>
          ))}
        </ul>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-2 font-medium">Agent</th>
                {state.services.map((s) => (
                  <th key={s.id} className="px-1 font-medium">
                    <span className="flex items-center gap-1.5">
                      <ServiceIcon id={s.id} size={14} className={s.kind === "demo" ? "text-muted" : undefined} />
                      {s.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.matrix.map((row) => (
                <tr key={row.agentId} className="border-t border-line align-top">
                  <td className="py-2 pr-2 font-medium">{state.agents.find((a) => a.id === row.agentId)?.name}</td>
                  {row.cells.map((c) => {
                    const svc = state.services.find((s) => s.id === c.serviceId)!;
                    const key = `ag-${row.agentId}-${c.serviceId}`;
                    if (c.outOfRole) {
                      return (
                        <td key={c.serviceId} className="px-1 py-2 text-muted" title={c.outOfRole}>
                          <span aria-hidden>—</span>
                          <span className="sr-only">{c.outOfRole}</span>
                        </td>
                      );
                    }
                    return (
                      <td key={c.serviceId} className="px-1 py-2">
                        <label className="sr-only" htmlFor={key}>
                          {row.agentId} on {svc.name}
                        </label>
                        <select
                          id={key}
                          className={`w-full rounded-md border px-1 py-0.5 ${LEVEL_TONE[c.agentLevel] ?? LEVEL_TONE.none}`}
                          value={c.agentLevel}
                          disabled={busy !== null}
                          onChange={(e) => change({ op: "agent", agentId: row.agentId, serviceId: c.serviceId, level: e.target.value }, key, "Agent permission updated")}
                        >
                          {levelsUpTo(svc.max_level)
                            .filter((l) => LEVELS.indexOf(l) <= LEVELS.indexOf(c.agentMax))
                            .map((l) => (
                              <option key={l} value={l}>
                                {LEVEL_LABEL[l]}
                              </option>
                            ))}
                        </select>
                        <span title={c.reason} className={`mt-1 block ${LEVEL_TEXT[c.effective] ?? "text-muted"}`}>
                          {c.effective === "none" ? (
                            "no access"
                          ) : (
                            <>
                              <span className="text-muted">can </span>
                              {LEVEL_LABEL[c.effective]}
                            </>
                          )}
                          {c.effective !== c.agentLevel && <span className="sr-only"> ({c.reason})</span>}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** Connect / sync / disconnect for the read-only Google connectors. */
function GoogleControls({ service, state, refresh }: { service: SectionProps["state"]["services"][number]; state: SectionProps["state"]; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const info = state.google.find((g) => g.service_id === service.id);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  if (!state.config.google.configured) {
    return <span className="block max-w-[14rem] text-left text-xs text-muted">Not set up. Add GOOGLE_CLIENT_ID to .env.local — see docs/GOOGLE_SETUP.md.</span>;
  }
  const start = () =>
    act("start", async () => {
      const { url } = await post<{ url: string }>("/api/oauth/google", { op: "start", service: service.id });
      window.location.assign(url);
    });
  if (service.connection_state !== "connected") {
    return (
      <Button variant="primary" busy={busy === "start"} onClick={start}>
        Connect with Google
      </Button>
    );
  }
  if (info?.needsReconnect) {
    // Connected with an older, different permission (e.g. before Gmail switched to gmail.readonly).
    return (
      <div className="flex max-w-[15rem] flex-col items-end gap-1.5 text-right">
        <span className="text-[11px] text-warn">Permission changed in this version: reconnect to keep using it. Access is reset to None; set it back to Read afterwards.</span>
        <Button variant="primary" busy={busy === "start"} onClick={start}>
          Reconnect to upgrade
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      {info && (
        <span className="text-[11px] text-muted">
          {info.account ? `${info.account} · ` : ""}
          {service.id === "gmail-drafts" ? "drafts only after your approval" : service.id === "google-calendar-app" ? "events only after your approval" : info.last_sync_at ? `synced ${relative(info.last_sync_at)}` : "not synced yet"}
        </span>
      )}
      <div className="flex gap-1.5">
        {service.id !== "gmail-drafts" && service.id !== "google-calendar-app" && (
          <Button
            busy={busy === "sync"}
            onClick={() =>
              act("sync", async () => {
                const r = await post<{ messages?: number; events?: number }>("/api/oauth/google", { op: "sync", service: service.id });
                toast(r.messages !== undefined ? `Synced ${r.messages} message headers` : `Synced ${r.events} events`, "ok");
                await refresh();
              })
            }
          >
            Sync now
          </Button>
        )}
        <Button
          variant="danger"
          busy={busy === "dc"}
          onClick={() =>
            confirm(`Disconnect ${service.name}? The token is revoked at Google and all synced data is deleted.`) &&
            act("dc", async () => {
              await post("/api/permissions", { op: "disconnect", serviceId: service.id });
              toast(`${service.name} disconnected; token revoked and data deleted`, "ok");
              await refresh();
            })
          }
        >
          Disconnect &amp; revoke
        </Button>
      </div>
    </div>
  );
}
