import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/http";
import { addDocument, answerRetrieval, deleteDocument, indexLocal, retrieve, RetrieveInputSchema, setAtlasShare, syncCorpusToAtlas } from "@/server/retrieval/knowledge";
import { atlasStatus } from "@/server/retrieval/atlas";
import { importCsv, previewCsv } from "@/server/csv";
import { importMarkdown, MarkdownFilesSchema, previewMarkdown } from "@/server/markdown";
import { one } from "@/server/db";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("search"), input: RetrieveInputSchema }),
  z.object({ op: z.literal("answer"), retrievalId: z.string().max(64) }),
  z.object({ op: z.literal("index-local") }),
  z.object({ op: z.literal("sync-atlas") }),
  z.object({ op: z.literal("atlas-status") }),
  z.object({ op: z.literal("csv-preview"), text: z.string().max(250_000) }),
  z.object({ op: z.literal("csv-import"), text: z.string().max(250_000), fileName: z.string().max(200) }),
  z.object({ op: z.literal("add-note"), title: z.string().min(1).max(200), content: z.string().min(1).max(20_000), tags: z.array(z.string().max(40)).max(10).default([]) }),
  z.object({ op: z.literal("delete-doc"), id: z.string().max(64) }),
  z.object({ op: z.literal("atlas-share"), id: z.string().max(64), share: z.boolean() }),
  z.object({ op: z.literal("md-preview"), files: MarkdownFilesSchema }),
  z.object({ op: z.literal("md-import"), files: MarkdownFilesSchema }),
]);

export const POST = handler(true, async (req, ctx) => {
  // Markdown imports can carry several files; everything else stays under the default limit.
  const body = Body.parse(await readJson(req, 2_000_000));
  switch (body.op) {
    case "search":
      rateLimit(`search-${body.input.provider}`, body.input.provider === "atlas-voyage" ? 20 : 40);
      return retrieve(ctx, body.input);
    case "answer":
      rateLimit("answer", 6);
      return answerRetrieval(ctx, body.retrievalId);
    case "index-local":
      rateLimit("index-local", 4);
      return indexLocal(ctx);
    case "sync-atlas":
      rateLimit("sync-atlas", 2);
      return syncCorpusToAtlas(ctx);
    case "atlas-status":
      rateLimit("atlas-status", 10);
      return atlasStatus();
    case "csv-preview":
      return previewCsv(body.text);
    case "csv-import":
      return importCsv(ctx, body.text, body.fileName);
    case "add-note":
      return { id: addDocument(ctx, { title: body.title, content: body.content, tags: body.tags, sourceType: "note", sourceRef: "dashboard:manual-note", isDemo: false }) };
    case "md-preview":
      return { files: previewMarkdown(body.files) };
    case "md-import":
      return importMarkdown(ctx, body.files);
    case "delete-doc": {
      const doc = one<{ is_demo: number }>(ctx.db, "SELECT is_demo FROM documents WHERE id = ?", body.id);
      if (!doc) throw new HttpError(404, "Document not found");
      if (doc.is_demo) throw new HttpError(400, "Demo documents are removed with Reset, not individually.");
      await deleteDocument(ctx, body.id);
      return { ok: true };
    }
    case "atlas-share":
      rateLimit("atlas-share", 6);
      return setAtlasShare(ctx, body.id, body.share);
  }
});
