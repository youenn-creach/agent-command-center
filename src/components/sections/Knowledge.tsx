"use client";

import { useState } from "react";
import type { SectionProps } from "../Dashboard";
import { Badge, Button, Card, Empty, Field, inputCls, SectionHeader, useToast } from "../ui";
import { post } from "../api";
import { MarkdownImport } from "../MarkdownImport";
import { AboutMeCard } from "../AboutMe";

interface Preview {
  columns: string[];
  valid: { line: number; title: string; content: string; tags: string[]; warnings: string[] }[];
  errors: { line: number; message: string }[];
}

export function KnowledgeView({ state, refresh }: SectionProps) {
  const toast = useToast();
  const [note, setNote] = useState({ title: "", content: "", tags: "" });
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run<T>(key: string, body: unknown, ok: (r: T) => string, path = "/api/knowledge") {
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

  async function onFile(file: File | undefined) {
    setPreview(null);
    if (!file) return setCsv(null);
    if (file.size > 200_000) return toast("CSV is larger than 200 KB", "danger");
    const text = await file.text();
    setCsv({ name: file.name, text });
    setBusy("preview");
    try {
      setPreview(await post<Preview>("/api/knowledge", { op: "csv-preview", text }));
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  async function exportData() {
    const res = await fetch("/api/data");
    const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `agent-command-center-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <SectionHeader
        title="Knowledge & Data"
        description={
          state.config.mode === "demo"
            ? "What agents can search, where it came from, and whether it is indexed. Indexing is always your choice. In the demo, only the fictional corpus can be synced to Atlas."
            : "What agents can search, where it came from, and whether it is indexed. Indexing is always your choice. Your notes and CSV imports stay on this machine unless you share a note to Atlas yourself; email is never sent there."
        }
      />
      <AboutMeCard facts={state.memory} refresh={refresh} />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title={`Documents (${state.knowledge.documents.length})`} subtitle={`${state.knowledge.stats.chunks} chunks · ${state.knowledge.stats.localVectors} local vectors`}>
          {state.knowledge.documents.length === 0 ? (
            <Empty title="No documents" />
          ) : (
            <ul className="divide-y divide-line">
              {state.knowledge.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{d.title}</span>
                    <span className="block text-xs text-muted">
                      <code>{d.source_ref}</code> · {d.tags.join(", ") || "no tags"}
                    </span>
                  </span>
                  {d.is_demo ? <Badge tone="warn">demo</Badge> : <Badge tone="accent">yours</Badge>}
                  <Badge tone={d.indexed >= d.chunks ? "ok" : "neutral"}>{d.indexed >= d.chunks ? "indexed" : `${d.indexed}/${d.chunks} indexed`}</Badge>
                  {!d.is_demo && d.atlas_synced_at && (
                    <Badge tone="mongo" title={`Shared to MongoDB Atlas on ${new Date(d.atlas_synced_at).toLocaleString()}`}>
                      in Atlas
                    </Badge>
                  )}
                  {!d.is_demo && state.config.mode !== "demo" && (
                    <label
                      className="inline-flex items-center gap-1.5 text-xs text-muted"
                      title={state.live.enabled || d.atlas_share ? "Embedded with Voyage AI and stored in your Atlas cluster, searchable with Atlas Vector Search. Untick to remove it there." : "Turn on Atlas live mode in Under the hood first."}
                    >
                      <input
                        type="checkbox"
                        className="accent-[var(--mongo)]"
                        checked={Boolean(d.atlas_share)}
                        disabled={busy === `share-${d.id}` || (!d.atlas_share && !state.live.enabled)}
                        onChange={(e) =>
                          run(`share-${d.id}`, { op: "atlas-share", id: d.id, share: e.target.checked }, (r: { shared: boolean; chunks: number }) =>
                            r.shared ? `Shared to Atlas (${r.chunks} chunk${r.chunks === 1 ? "" : "s"})` : "Removed from Atlas",
                          )
                        }
                      />
                      Share to Atlas
                    </label>
                  )}
                  {!d.is_demo && (
                    <Button variant="ghost" busy={busy === `del-${d.id}`} onClick={() => run(`del-${d.id}`, { op: "delete-doc", id: d.id }, () => "Deleted")}>
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Add a note" subtitle="Stored locally; not indexed until you choose to.">
            <div className="space-y-2">
              <Field label="Title">
                <input className={inputCls} value={note.title} maxLength={200} onChange={(e) => setNote({ ...note, title: e.target.value })} />
              </Field>
              <Field label="Content">
                <textarea className={inputCls} rows={4} value={note.content} maxLength={20000} onChange={(e) => setNote({ ...note, content: e.target.value })} />
              </Field>
              <Field label="Tags (comma-separated)">
                <input className={inputCls} value={note.tags} onChange={(e) => setNote({ ...note, tags: e.target.value })} />
              </Field>
              <Button
                variant="primary"
                disabled={!note.title.trim() || !note.content.trim()}
                busy={busy === "note"}
                onClick={async () => {
                  const r = await run("note", { op: "add-note", title: note.title, content: note.content, tags: note.tags.split(",").map((t) => t.trim()).filter(Boolean) }, () => "Note added");
                  if (r) setNote({ title: "", content: "", tags: "" });
                }}
              >
                Add note
              </Button>
            </div>
          </Card>

          <MarkdownImport refresh={refresh} />

          <Card title="Import a CSV" subtitle='Export a sheet as CSV with "title" and "content" columns (optional "tags", separated by ;). Max 200 KB / 500 rows. Public sheet links are not supported on purpose.'>
            <input type="file" accept=".csv,text/csv" aria-label="CSV file" className="text-xs" onChange={(e) => void onFile(e.target.files?.[0])} />
            {preview && csv && (
              <div className="mt-3 text-xs">
                <p>
                  <strong>{preview.valid.length}</strong> valid row(s), <strong>{preview.errors.length}</strong> rejected.
                </p>
                {preview.errors.length > 0 && (
                  <ul className="mt-1 max-h-24 overflow-auto text-danger">
                    {preview.errors.map((e) => (
                      <li key={e.line}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                  {preview.valid.slice(0, 20).map((r) => (
                    <li key={r.line} className="rounded bg-panel-2 px-2 py-1">
                      <span className="font-medium">{r.title}</span> — {r.content.slice(0, 80)}
                      {r.warnings.map((w) => (
                        <span key={w} className="block text-warn">
                          ⚠ {w}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-2"
                  variant="primary"
                  disabled={preview.valid.length === 0}
                  busy={busy === "import"}
                  onClick={async () => {
                    await run<{ imported: number }>("import", { op: "csv-import", text: csv.text, fileName: csv.name }, (r) => `Imported ${r.imported} rows`);
                    setPreview(null);
                    setCsv(null);
                  }}
                >
                  Import {preview.valid.length} row(s)
                </Button>
              </div>
            )}
          </Card>

          <Card title="Your data" subtitle="Export or delete what you added. Configuration and secrets are never included.">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void exportData()}>Export JSON</Button>
              <Button
                variant="danger"
                busy={busy === "clear"}
                onClick={() => confirm("Delete your notes, CSV imports, About me facts, request and search history, and the activity log?") && run("clear", { op: "clear-user-data" }, () => "Cleared", "/api/data")}
              >
                Clear my data
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
