"use client";

import { useState } from "react";
import { Badge, Button, Card, useToast } from "./ui";
import { post } from "./api";

interface Item {
  name: string;
  title: string;
  tags: string[];
  chars: number;
  warnings: string[];
  error?: string;
}

/** Upload several .md files (e.g. from an Obsidian vault), preview, then import the valid ones. */
export function MarkdownImport({ refresh }: { refresh: () => Promise<void> }) {
  const toast = useToast();
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [preview, setPreview] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(list: FileList | null) {
    setPreview(null);
    if (!list?.length) return;
    if (list.length > 50) return toast("Up to 50 files at a time", "danger");
    const picked = await Promise.all([...list].map(async (f) => ({ name: f.name, text: f.size > 100_000 ? "x".repeat(100_001) : await f.text() })));
    setFiles(picked);
    setBusy("preview");
    try {
      setPreview((await post<{ files: Item[] }>("/api/knowledge", { op: "md-preview", files: picked })).files);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  }

  const valid = preview?.filter((p) => !p.error) ?? [];
  return (
    <Card title="Import Markdown notes" subtitle="Select .md files (e.g. from an Obsidian vault). Titles and tags come from front-matter or the first heading. Max 50 files, 100k characters each.">
      <input type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="Markdown files" className="text-xs" onChange={(e) => void choose(e.target.files)} />
      {preview && (
        <div className="mt-3 text-xs">
          <p>
            <strong>{valid.length}</strong> ready, <strong>{preview.length - valid.length}</strong> skipped.
          </p>
          <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
            {preview.map((p) => (
              <li key={p.name} className="rounded bg-panel-2 px-2 py-1">
                <span className="font-medium">{p.title || p.name}</span> <span className="text-muted">· {p.name}</span>
                {p.tags.map((t) => (
                  <Badge key={t} className="ml-1">
                    {t}
                  </Badge>
                ))}
                {p.error && <span className="block text-danger">✕ {p.error}</span>}
                {p.warnings.map((w) => (
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
            disabled={!valid.length}
            busy={busy === "import"}
            onClick={async () => {
              setBusy("import");
              try {
                const r = await post<{ imported: number }>("/api/knowledge", { op: "md-import", files });
                toast(`Imported ${r.imported} note(s). Index them from Under the hood when you want semantic search.`, "ok");
                setPreview(null);
                setFiles([]);
                await refresh();
              } catch (e) {
                toast((e as Error).message, "danger");
              } finally {
                setBusy(null);
              }
            }}
          >
            Import {valid.length} note(s)
          </Button>
        </div>
      )}
    </Card>
  );
}
