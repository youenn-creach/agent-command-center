import { UserError } from "./errors";
import { z } from "zod";
import type { Ctx } from "./db";
import { addDocument } from "./retrieval/knowledge";
import { logActivity } from "./activity";
import { injectionFlags } from "./retrieval/text";

/**
 * User-initiated import of Markdown notes (e.g. files from an Obsidian vault), uploaded through
 * the browser — the server never reads paths from disk. Preview first, then import valid files.
 */

export const MD_LIMITS = { maxFiles: 50, maxFileChars: 100_000, maxTotalChars: 1_500_000 };

export const MarkdownFilesSchema = z
  .array(z.object({ name: z.string().min(1).max(200), text: z.string().max(MD_LIMITS.maxFileChars + 1) }))
  .min(1)
  .max(MD_LIMITS.maxFiles);

export interface MarkdownPreviewItem {
  name: string;
  title: string;
  tags: string[];
  chars: number;
  warnings: string[];
  error?: string;
}

/** Splits an optional YAML front-matter block and reads `title:` and `tags:` (list or comma/space separated). */
export function parseMarkdown(name: string, raw: string) {
  let text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  let title = "";
  let tags: string[] = [];
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    text = text.slice(fm[0].length);
    const t = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (t) title = t[1];
    const inline = fm[1].match(/^tags:\s*\[?([^\n\]]*)\]?\s*$/m);
    const list = fm[1].match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
    if (list) tags = list[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim());
    else if (inline) tags = inline[1].split(/[,\s]+/);
  }
  const heading = text.match(/^#\s+(.+)$/m);
  title = (title || heading?.[1] || name.replace(/\.(md|markdown)$/i, "")).trim().slice(0, 200);
  tags = [...new Set(tags.map((x) => x.replace(/^#/, "").trim().toLowerCase()).filter((x) => /^[\p{L}\p{N}_-]{1,40}$/u.test(x)))].slice(0, 9);
  return { title, tags, content: text.trim() };
}

export function previewMarkdown(files: z.input<typeof MarkdownFilesSchema>): MarkdownPreviewItem[] {
  const parsed = MarkdownFilesSchema.parse(files);
  const total = parsed.reduce((n, f) => n + f.text.length, 0);
  if (total > MD_LIMITS.maxTotalChars) throw new UserError(`Files are too large in total (max ${MD_LIMITS.maxTotalChars / 1000}k characters)`);
  return parsed.map((f) => {
    const base = { name: f.name.slice(0, 200), title: "", tags: [] as string[], chars: f.text.length, warnings: [] as string[] };
    if (!/\.(md|markdown|txt)$/i.test(f.name)) return { ...base, error: "Not a .md / .markdown / .txt file" };
    if (f.text.length > MD_LIMITS.maxFileChars) return { ...base, error: `Larger than ${MD_LIMITS.maxFileChars / 1000}k characters` };
    if (f.text.includes("\u0000")) return { ...base, error: "Looks like a binary file" };
    const md = parseMarkdown(f.name, f.text);
    if (!md.content) return { ...base, title: md.title, error: "Empty note" };
    const flags = injectionFlags(md.content);
    return { ...base, title: md.title, tags: md.tags, warnings: flags.length ? [`contains instruction-like text (${flags.join(", ")}); it will be treated as data`] : [] };
  });
}

export function importMarkdown(ctx: Ctx, files: z.input<typeof MarkdownFilesSchema>) {
  const preview = previewMarkdown(files);
  const parsed = MarkdownFilesSchema.parse(files);
  let imported = 0;
  preview.forEach((p, i) => {
    if (p.error) return;
    const md = parseMarkdown(parsed[i].name, parsed[i].text);
    const safeName = parsed[i].name.replace(/[^\w.\- ]/g, "_").slice(0, 120);
    addDocument(ctx, { title: md.title, sourceType: "note", sourceRef: `md:${safeName}`, tags: [...md.tags, "markdown"], content: md.content.slice(0, 50_000), isDemo: false });
    imported++;
  });
  logActivity(ctx, { actor: "user", kind: "data_access", serviceId: "demo-notes", outcome: "ok", summary: `Imported ${imported} Markdown note(s) (${preview.length - imported} skipped). Not indexed until you choose to.` });
  return { imported, skipped: preview.length - imported };
}
