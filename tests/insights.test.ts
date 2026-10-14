import { describe, expect, it, vi } from "vitest";
import { all, run } from "@/server/db";
import { reloadConfig } from "@/server/config";
import { impactSummary, MINUTES } from "@/server/impact";
import { briefingHasRealGoogleData, weeklyReview } from "@/server/agents/chiefOfStaff";
import { disconnectGoogle, handleCallback, SCOPES, startAuth, type Fetcher } from "@/server/connectors/google";
import { auditSubscriptions, scanBookings, scanWaitingOn } from "@/server/connectors/gmailInsights";
import { listInsights, proposeNudge, remindAboutBooking } from "@/server/insights";
import { callTool } from "@/server/tools/registry";
import { RunBudget } from "@/server/tools/budget";
import { PolicyError } from "@/server/policy/engine";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { listReminders } from "@/server/reminders";
import { seededCtx } from "./helpers";

// "Now" is 2026-10-12T10:00:00Z (helpers.makeCtx).
const NOW = Date.parse("2026-10-12T10:00:00Z");
const daysAgo = (n: number) => String(NOW - n * 86_400_000);
const h = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const msg = (id: string, labels: string[], days: number, headers: Record<string, string>) => ({ id, threadId: id, labelIds: labels, internalDate: daysAgo(days), payload: { headers: h(headers) } });

const THREADS: Record<string, unknown> = {
  // You wrote last, 5 days ago: waiting on Ana.
  t1: { id: "t1", messages: [msg("a", ["INBOX"], 8, { From: "Ana <ana@example.com>", Subject: "Shelves" }), msg("b", ["SENT"], 5, { From: "Me <me@example.com>", To: "Ana López <ana@example.com>", Subject: "Re: Shelves", "Message-ID": "<b@mail.example.com>" })] },
  // Bob answered: not waiting.
  t2: { id: "t2", messages: [msg("c", ["SENT"], 6, { From: "Me <me@example.com>", To: "bob@example.com", Subject: "Trip" }), msg("d", ["INBOX"], 2, { From: "bob@example.com", Subject: "Re: Trip" })] },
  // Sent to a no-reply address: ignored.
  t3: { id: "t3", messages: [msg("e", ["SENT"], 5, { From: "Me <me@example.com>", To: "no-reply@shop.example", Subject: "Order question" })] },
  // To yourself at another address (same name): not someone owing you an answer.
  t5: { id: "t5", messages: [msg("g", ["SENT"], 6, { From: "Zoé Lefèvre <me@example.com>", To: "Zoe Lefevre <me.other@example.org>", Subject: "Scan of the prescription" })] },
  // Too recent to nag about.
  t4: { id: "t4", messages: [msg("f", ["SENT"], 1, { From: "Me <me@example.com>", To: "cleo@example.com", Subject: "Lunch?" })] },
};
const MESSAGES: Record<string, unknown> = {
  b1: msg("b1", ["INBOX"], 3, { From: "Ryanair <noreply@ryanair.example>", Subject: "Your e-ticket confirmation: Paris to Lisbon" }),
  b2: msg("b2", ["INBOX", "CATEGORY_PROMOTIONS"], 2, { From: "Deals <deals@air.example>", Subject: "Flight booking deals this weekend!" }),
  b3: msg("b3", ["INBOX"], 4, { From: "Hotel Lumen <stay@lumen.example>", Subject: "Booking confirmed: 2 nights" }),
  b4: msg("b4", ["INBOX"], 5, { From: "Shirts Example <orders@shirts.example>", Subject: "Order confirmation #12345" }),
  b5: msg("b5", ["INBOX"], 6, { From: "Banque Example <info@bank.example>", Subject: "Confirmation de votre virement" }),
  b6: msg("b6", ["INBOX"], 7, { From: "Volotea <noreply@volotea.example>", Subject: "Your booking is confirmed" }),
  b7: msg("b7", ["INBOX"], 8, { From: "SNCF Connect <noreply@sncf-connect.example>", Subject: "Votre réservation est confirmée" }),
  b8: msg("b8", ["INBOX"], 9, { From: "Hôtel du Port <contact@hotel.example>", Subject: "Confirmation de votre séjour" }),
  b9: msg("b9", ["INBOX"], 10, { From: "Renfe <venta@renfe.example>", Subject: "Confirmación de tu billete de tren" }),
  b10: msg("b10", ["INBOX"], 11, { From: "Vueling <noreply@vueling.example>", Subject: "Tu tarjeta de embarque para Barcelona" }),
  b11: msg("b11", ["INBOX"], 12, { From: "Hotel Arts <reserves@hotel.example>", Subject: "Reserva confirmada: 2 nits, 5th Ave" }),
  b12: msg("b12", ["INBOX"], 13, { From: "Botiga <comandes@botiga.example>", Subject: "Confirmació de la teva comanda" }),
  b13: msg("b13", ["INBOX"], 14, { From: "Banc <avisos@banc.example>", Subject: "Confirmación de transferencia" }),
  b14: msg("b14", ["INBOX"], 15, { From: "Banque <info@banque.example>", Subject: "Enregistrement de votre nouveau bénéficiaire" }),
  b16: msg("b16", ["INBOX"], 17, { From: "Booking.com <noreply@booking.com>", Subject: "Booking.com – TR7DC4 is your verification code" }),
  b17: msg("b17", ["INBOX"], 18, { From: "Seguros <x@seguros.example>", Subject: "Confirmación de la póliza de seguro de viaje" }),
  b15: msg("b15", ["INBOX"], 16, { From: "Rentals <noreply@cars.example>", Subject: "Thanks! Your car rental at Lyon - Central Train Station is confirmed" }),
  s1: msg("s1", ["INBOX"], 3, { From: "Streamly <news@streamly.example>", Subject: "Your receipt for October", "List-Unsubscribe": "<mailto:u@streamly.example>" }),
  s2: msg("s2", ["INBOX"], 40, { From: "Streamly <news@streamly.example>", Subject: "New this week", "List-Unsubscribe": "<mailto:u@streamly.example>" }),
  s3: msg("s3", ["INBOX"], 9, { From: "Recipes <hello@recipes.example>", Subject: "Autumn traybakes", "List-Unsubscribe": "<https://recipes.example/u>" }),
  s4: msg("s4", ["INBOX"], 5, { From: "Gimnàs <hola@gimnas.example>", Subject: "El teu rebut de novembre" }),
  s5: msg("s5", ["INBOX"], 6, { From: "Revista <noticias@revista.example>", Subject: "Novedades de la semana" }),
};

function fakeGmail() {
  const calls: { method: string; url: string }[] = [];
  let scope = "";
  const json = (b: unknown) => Response.json(b);
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url });
    const u = new URL(url);
    if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "t", refresh_token: "r", expires_in: 3600, scope });
    if (u.pathname.endsWith("/users/me/drafts")) return json({ id: "d1" });
    const thread = u.pathname.match(/\/threads\/(\w+)$/)?.[1];
    if (thread) return json(THREADS[thread]);
    const id = u.pathname.match(/\/messages\/(\w+)$/)?.[1];
    if (id) return json(MESSAGES[id]);
    const q = u.searchParams.get("q") ?? "";
    if (u.searchParams.get("labelIds") === "SENT") return json({ messages: ["t1", "t2", "t3", "t4", "t5"].map((t) => ({ id: `m${t}`, threadId: t })) });
    if (q.includes("subject:flight")) return json({ messages: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10", "b11", "b12", "b13", "b14", "b15", "b16", "b17"].map((id) => ({ id })) });
    if (q.includes("unsubscribe")) {
      // The search looks for the unsubscribe wording in every language.
      expect(q).toContain('"darse de baja"');
      expect(q).toContain('"donar-se de baixa"');
      // Two pages: the audit follows nextPageToken.
      if (u.searchParams.get("pageToken") === "p2") return json({ messages: [{ id: "s4" }, { id: "s5" }] });
      return json({ messages: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], nextPageToken: "p2" });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, fetcher, setScope: (s: string) => (scope = s) };
}

async function connected(svcs: ("gmail" | "gmail-drafts")[] = ["gmail"]) {
  const ctx = seededCtx();
  const g = fakeGmail();
  for (const svc of svcs) {
    g.setScope(SCOPES[svc][0]);
    await handleCallback(ctx, { code: "c", state: new URL(startAuth(ctx, svc)).searchParams.get("state") }, g.fetcher);
  }
  return { ctx, g };
}

describe("inbox insights (Gmail headers only)", () => {
  it("finds threads where you wrote last, 3+ days ago, skipping replies, no-reply targets and recent ones", async () => {
    const { ctx, g } = await connected();
    expect(await scanWaitingOn(ctx, g.fetcher)).toEqual({ threads: 5, waiting: 1 }); // t5 is a note to self
    const real = listInsights(ctx).waiting.filter((w) => !w.is_demo);
    expect(real).toMatchObject([{ thread_id: "t1", recipient: "Ana López <ana@example.com>", subject: "Re: Shelves", rfc_message_id: "<b@mail.example.com>" }]);
  });

  it("classifies booking confirmations (English, French, Spanish, Catalan) and ignores promotions, shop orders and bank messages", async () => {
    const { ctx, g } = await connected();
    await scanBookings(ctx, g.fetcher);
    const real = listInsights(ctx).bookings.filter((b) => !b.is_demo);
    expect(real.map((b) => [b.id, b.kind])).toEqual([
      ["gm_b1", "flight"],
      ["gm_b3", "stay"],
      ["gm_b6", "flight"], // airline by name
      ["gm_b7", "train"], // French
      ["gm_b8", "stay"], // French
      ["gm_b9", "train"], // Spanish
      ["gm_b10", "flight"], // Spanish
      ["gm_b11", "stay"], // Catalan ("5th Ave" doesn't make it a train)
      ["gm_b15", "car"], // a rental desk at a train station is a car, not a train
    ]);
    // b14: a bank's "new beneficiary" registration ("enregistrement") is not a check-in.
    // b16, b17: a sign-in code from booking.com and a travel-insurance policy are not trips either.
    // b12 (Catalan shop order) and b13 (Spanish bank transfer) are not trips.
    // A shop order and a bank transfer "confirmation" are not trips (b4, b5); promotions neither (b2).
  });

  it("groups subscription senders and flags the ones that look paid", async () => {
    const { ctx, g } = await connected();
    expect(await auditSubscriptions(ctx, g.fetcher)).toEqual({ scanned: 5, senders: 4 });
    const real = listInsights(ctx).subscriptions.filter((s) => !s.is_demo);
    expect(real).toMatchObject([
      { sender: "news@streamly.example", name: "Streamly", messages: 2, looks_paid: 1, can_unsubscribe: 1 },
      { sender: "hola@gimnas.example", looks_paid: 1 }, // Catalan "rebut" (receipt)
      { sender: "hello@recipes.example", messages: 1, looks_paid: 0 },
      { sender: "noticias@revista.example", looks_paid: 0 },
    ]);
  });

  it("only ever GETs headers: no bodies, no writes", async () => {
    const { ctx, g } = await connected();
    await scanWaitingOn(ctx, g.fetcher);
    await scanBookings(ctx, g.fetcher);
    await auditSubscriptions(ctx, g.fetcher);
    const api = g.calls.filter((c) => c.url.includes("gmail.googleapis.com"));
    expect(api.length).toBeGreaterThan(5);
    expect(api.every((c) => c.method === "GET")).toBe(true);
    expect(api.some((c) => /format=(full|raw)/.test(c.url))).toBe(false);
    expect(api.filter((c) => /\/messages\/\w+\?/.test(c.url)).every((c) => c.url.includes("format=metadata"))).toBe(true);
  });

  it("is permission-checked like every other tool", async () => {
    const { ctx } = await connected();
    await expect(callTool(ctx, "follow_up", "gmail.scan_waiting", {}, new RunBudget(1, 1000))).rejects.toThrow(PolicyError);
    expect(all(ctx.db, "SELECT * FROM waiting_on WHERE is_demo = 0")).toEqual([]);
  });

  it("“Draft a nudge” proposes a Gmail draft in the same thread, for approval", async () => {
    const { ctx, g } = await connected(["gmail", "gmail-drafts"]);
    await scanWaitingOn(ctx, g.fetcher);
    setServiceLevel(ctx, "gmail-drafts", "write_with_approval");
    setAgentLevel(ctx, "follow_up", "gmail-drafts", "write_with_approval");
    const { actionId } = await proposeNudge(ctx, "t1");
    const a = all<{ status: string; kind: string; payload: string }>(ctx.db, "SELECT status, kind, payload FROM actions WHERE id = ?", actionId)[0];
    expect(a).toMatchObject({ status: "proposed", kind: "email_draft" });
    expect(JSON.parse(a.payload)).toMatchObject({ to: "ana@example.com", subject: "Re: Shelves", threadId: "t1", inReplyTo: "<b@mail.example.com>", body: expect.stringMatching(/^Hi Ana,/) });
    expect(g.calls.some((c) => c.url.endsWith("/drafts"))).toBe(false); // nothing reaches Gmail before approval
  });

  it("disconnecting Gmail deletes everything derived from it, and keeps the fictional demo rows", async () => {
    const { ctx, g } = await connected();
    await scanWaitingOn(ctx, g.fetcher);
    await scanBookings(ctx, g.fetcher);
    await auditSubscriptions(ctx, g.fetcher);
    expect(listInsights(ctx).waiting.some((w) => !w.is_demo)).toBe(true);
    await disconnectGoogle(ctx, "gmail", g.fetcher);
    const after = listInsights(ctx);
    for (const rows of [after.waiting, after.bookings, after.subscriptions]) expect(rows.filter((r) => !r.is_demo)).toEqual([]);
    expect(after.scannedAt).toEqual({ waiting: null, bookings: null, subscriptions: null });
    expect(after.waiting.some((w) => w.is_demo)).toBe(true);
  });

  it("“Remind me” on a booking adds a dashboard reminder", async () => {
    const { ctx, g } = await connected();
    await scanBookings(ctx, g.fetcher);
    remindAboutBooking(ctx, "gm_b1");
    expect(listReminders(ctx).map((r) => r.text)).toContain("Check in for: Your e-ticket confirmation: Paris to Lisbon");
  });
});

describe("Impact card", () => {
  const action = (ctx: Awaited<ReturnType<typeof connected>>["ctx"], id: string, key: string, kind: string, status: string, executedDaysAgo: number | null, createdDaysAgo = 6) =>
    run(
      ctx.db,
      `INSERT INTO actions (id, agent_id, service_id, kind, title, destination, payload, payload_hash, status, idempotency_key, executed_at, is_demo, created_at, updated_at)
       VALUES (?, 'follow_up', 'gmail-drafts', ?, 't', 'd', '{}', 'h', ?, ?, ?, 0, ?, ?)`,
      id, kind, status, key,
      executedDaysAgo === null ? null : new Date(NOW - executedDaysAgo * 86_400_000).toISOString(),
      new Date(NOW - createdDaysAgo * 86_400_000).toISOString(), new Date(NOW).toISOString(),
    );

  it("a thread answered after your approved nudge counts as revived; one answered before it doesn't", async () => {
    const { ctx, g } = await connected();
    // Bob (t2) answered 2 days ago, after a nudge approved 4 days ago.
    action(ctx, "a1", "nudge:t2:2026-10-08T10:00", "email_draft", "executed", 4);
    await scanWaitingOn(ctx, g.fetcher);
    expect(all(ctx.db, "SELECT thread_id FROM revived_threads WHERE is_demo = 0")).toEqual([{ thread_id: "t2" }]);

    const other = await connected();
    // This nudge was approved yesterday, after Bob's answer: not what revived the thread.
    action(other.ctx, "a2", "nudge:t2:2026-10-11T10:00", "email_draft", "executed", 1);
    await scanWaitingOn(other.ctx, other.g.fetcher);
    expect(all(other.ctx.db, "SELECT thread_id FROM revived_threads WHERE is_demo = 0")).toEqual([]);
  });

  it("counts only what happened this week, and estimates time saved with a visible formula", async () => {
    vi.stubEnv("ACC_MODE", "personal");
    reloadConfig();
    try {
      const { ctx, g } = await connected();
      action(ctx, "n1", "nudge:t2:2026-10-08T10:00", "email_draft", "executed", 4);
      action(ctx, "r1", "reply:1", "email_draft", "executed", 1);
      action(ctx, "r2", "reply:2", "email_draft", "dismissed", null);
      action(ctx, "r3", "reply:3", "email_draft", "executed", 9, 10); // last week
      await scanWaitingOn(ctx, g.fetcher);
      await scanBookings(ctx, g.fetcher);
      remindAboutBooking(ctx, "gm_b1");
      const i = impactSummary(ctx);
      expect(i).toMatchObject({ repliesDrafted: 2, repliesApproved: 1, nudgesApproved: 1, conversationsRevived: 1, stillWaiting: 1, bookingsTracked: 9, bookingReminders: 1, auditRan: false });
      expect(i.minutesSaved).toBe(MINUTES.reply + MINUTES.nudge + MINUTES.bookingReminder);
      expect(i.formula).toMatch(/per approved reply/);
    } finally {
      vi.unstubAllEnvs();
      reloadConfig();
    }
  });
});

describe("MCP briefings", () => {
  it("a briefing with real Gmail or Calendar data is never handed to an MCP client", async () => {
    const { ctx, g } = await connected();
    const demoOnly = { steps: [{ tool: "inbox.list_messages", outcome: "ok" }, { tool: "news.list_items", outcome: "ok" }] };
    expect(briefingHasRealGoogleData(ctx, demoOnly)).toBe(false);
    expect(briefingHasRealGoogleData(ctx, { steps: [{ tool: "gmail.list_messages", outcome: "ok" }] })).toBe(true);
    expect(briefingHasRealGoogleData(ctx, { steps: [{ tool: "gcal.list_events", outcome: "ok" }] })).toBe(true);
    expect(briefingHasRealGoogleData(ctx, { steps: [{ tool: "gmail.list_messages", outcome: "denied" }] })).toBe(false);
    // Real "still no answer" threads from an earlier scan end up in the text even without a Gmail step.
    await scanWaitingOn(ctx, g.fetcher);
    expect(briefingHasRealGoogleData(ctx, demoOnly)).toBe(true);
  });
});

describe("weekly review", () => {
  it("refreshes the subscription audit once a week when the Inbox agent may read Gmail", async () => {
    const { ctx, g } = await connected();
    vi.stubGlobal("fetch", g.fetcher);
    try {
      // Without access the audit step is skipped (and logged) and the review still arrives.
      const denied = await weeklyReview(ctx);
      const first = all<{ body: string; provenance: string }>(ctx.db, "SELECT body, provenance FROM briefings WHERE id = ?", denied.briefingId)[0];
      expect(first.body).not.toMatch(/\*\*Subscriptions\*\*/);
      expect(JSON.parse(first.provenance).steps).toContainEqual(expect.objectContaining({ tool: "gmail.audit_subscriptions", outcome: "skipped" }));

      setServiceLevel(ctx, "gmail", "read");
      setAgentLevel(ctx, "inbox", "gmail", "read");
      const out = await weeklyReview(ctx);
      const body = all<{ body: string }>(ctx.db, "SELECT body FROM briefings WHERE id = ?", out.briefingId)[0].body;
      expect(body).toMatch(/\*\*Subscriptions\*\*\n- 4 newsletter sender\(s\) in your recent mail, 2 look paid/);
      expect(listInsights(ctx).scannedAt.subscriptions).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
