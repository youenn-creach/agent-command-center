import { z } from "zod";
import type { Ctx } from "./db";
import { addDocument } from "./retrieval/knowledge";
import { logActivity } from "./activity";
import { injectionFlags } from "./retrieval/text";

/**
 * User-initiated CSV import (e.g. a sheet exported from a spreadsheet app). Two steps:
 * preview (parse + validate, nothing stored) and import (store only rows that passed).
 * No URLs are fetched; public-sheet links are deliberately not supported.
 */

export const CSV_LIMITS = { maxBytes: 200_000, maxRows: 500, maxFieldChars: 5_000 };

export class CsvError extends Error {}

/** RFC 4180-style parser: quoted fields, escaped quotes, CRLF/LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (inQuotes) throw new CsvError("Unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const RowSchema = z.object({
  title: z.string().trim().min(1, "title is empty").max(200, "title is longer than 200 characters"),
  content: z.string().trim().min(1, "content is empty").max(CSV_LIMITS.maxFieldChars, `content is longer than ${CSV_LIMITS.maxFieldChars} characters`),
  tags: z.array(z.string().regex(/^[\p{L}\p{N} _-]{1,40}$/u, "tags may only contain letters, numbers, spaces, - and _")).max(10),
});

export interface CsvPreview {
  columns: string[];
  valid: { line: number; title: string; content: string; tags: string[]; warnings: string[] }[];
  errors: { line: number; message: string }[];
}

export function previewCsv(text: string): CsvPreview {
  if (Buffer.byteLength(text, "utf8") > CSV_LIMITS.maxBytes) throw new CsvError(`File is larger than ${CSV_LIMITS.maxBytes / 1000} KB`);
  if (text.includes("\u0000")) throw new CsvError("File looks binary, not CSV");
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new CsvError("Need a header row and at least one data row");
  if (rows.length - 1 > CSV_LIMITS.maxRows) throw new CsvError(`Too many rows (max ${CSV_LIMITS.maxRows})`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ti = header.indexOf("title");
  const ci = header.indexOf("content");
  const gi = header.indexOf("tags");
  if (ti < 0 || ci < 0) throw new CsvError('Header must include "title" and "content" columns (optional: "tags", separated by ;)');

  const preview: CsvPreview = { columns: header, valid: [], errors: [] };
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    if (r.length !== header.length) {
      preview.errors.push({ line, message: `Expected ${header.length} columns, found ${r.length}` });
      return;
    }
    const tags = gi >= 0 ? r[gi].split(";").map((t) => t.trim()).filter(Boolean) : [];
    const parsed = RowSchema.safeParse({ title: r[ti], content: r[ci], tags });
    if (!parsed.success) {
      preview.errors.push({ line, message: parsed.error.issues[0]?.message ?? "Invalid row" });
      return;
    }
    const warnings: string[] = [];
    // Cells starting with these characters are interpreted as formulas if the data is ever re-exported to a spreadsheet.
    if (/^[=+\-@\t\r]/.test(parsed.data.title) || /^[=+\-@\t\r]/.test(parsed.data.content)) warnings.push("starts with a formula character; stored as plain text");
    const flags = injectionFlags(parsed.data.content);
    if (flags.length) warnings.push(`contains instruction-like text (${flags.join(", ")}); it will be treated as data`);
    preview.valid.push({ line, ...parsed.data, warnings });
  });
  return preview;
}

export function importCsv(ctx: Ctx, text: string, fileName: string) {
  const preview = previewCsv(text);
  const safeName = fileName.replace(/[^\w.\- ]/g, "_").slice(0, 100) || "upload.csv";
  for (const row of preview.valid) {
    addDocument(ctx, { title: row.title, sourceType: "csv_row", sourceRef: `csv:${safeName}#L${row.line}`, tags: [...row.tags, "csv"], content: row.content, isDemo: false });
  }
  logActivity(ctx, {
    actor: "user",
    kind: "data_access",
    serviceId: "demo-notes",
    outcome: "ok",
    summary: `Imported ${preview.valid.length} rows from ${safeName} (${preview.errors.length} rejected). Not indexed until you choose to.`,
  });
  return { imported: preview.valid.length, rejected: preview.errors.length };
}
