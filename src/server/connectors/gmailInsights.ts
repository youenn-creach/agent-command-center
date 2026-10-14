import { all, setSetting, tx, run, type Ctx } from "../db";
import { notifyNewItems } from "../notify";
import { AUTOMATED, GMAIL_API, gmailGet, header, type Fetcher } from "./google";

/**
 * Inbox insights from Gmail *headers only* (gmail.readonly; no message bodies):
 *  - waiting on others: threads where your message is the last one and nobody answered;
 *  - trips and bookings: confirmations for flights, trains, stays, tables, tickets;
 *  - subscriptions: senders of mail you can unsubscribe from, and which look paid.
 * Nothing is changed in Gmail: no labels, no unsubscribes, no replies.
 */

const BASE = GMAIL_API;
const ID = /^[\w-]{1,64}$/;
type Headers = { name: string; value: string }[];
type GmailMessage = { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Headers } };

function listUrl(q: string, max: number, label?: string, pageToken?: string) {
  const p = new URLSearchParams({ q, maxResults: String(max) });
  if (label) p.set("labelIds", label);
  if (pageToken) p.set("pageToken", pageToken);
  return `${BASE}/messages?${p}`;
}

/** Message ids matching `q`, following result pages up to `max` (Gmail returns at most 100 per page). */
async function listIds(ctx: Ctx, q: string, max: number, fetcher: Fetcher): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(ctx, listUrl(q, Math.min(100, max - ids.length), undefined, pageToken), fetcher);
    ids.push(...(page.messages ?? []).map((m) => m.id).filter((id) => ID.test(id)));
    pageToken = page.nextPageToken && /^[\w-]{1,200}$/.test(page.nextPageToken) ? page.nextPageToken : undefined;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

function metadataUrl(id: string, headers: string[]) {
  return `${BASE}/messages/${id}?format=metadata${headers.map((h) => `&metadataHeaders=${h}`).join("")}`;
}

/** Runs `fn` over `items`, at most `limit` at a time (keeps Gmail API usage polite). */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const iso = (internalDate: string | undefined, fallback: Date) => (internalDate ? new Date(Number(internalDate)).toISOString() : fallback.toISOString());
const email = (v: string) => (v.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? v.match(/[^\s<>,;]+@[^\s<>,;]+/)?.[0] ?? "").toLowerCase();

/** Threads you started or answered last, unanswered for at least `minDays`. */
export async function scanWaitingOn(ctx: Ctx, fetcher: Fetcher = fetch, minDays = 3) {
  const now = ctx.now();
  const sent = await gmailGet<{ messages?: { id: string; threadId?: string }[] }>(ctx, listUrl("newer_than:30d", 25, "SENT"), fetcher);
  const threadIds = [...new Set((sent.messages ?? []).map((m) => m.threadId).filter((t): t is string => !!t && ID.test(t)))].slice(0, 15);
  const threads = await pool(threadIds, 4, (id) =>
    gmailGet<{ id: string; messages?: GmailMessage[] }>(ctx, `${BASE}/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID`, fetcher),
  );
  const rows: { thread_id: string; recipient: string; subject: string; sent_at: string; rfc_message_id: string | null }[] = [];
  const answered: { thread_id: string; at: string }[] = [];
  for (const t of threads) {
    const msgs = [...(t.messages ?? [])].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
    const last = msgs.at(-1);
    if (!last?.labelIds?.includes("SENT")) {
      // Someone else spoke last: not waiting. If you had nudged this thread, the nudge worked.
      if (last) answered.push({ thread_id: t.id, at: iso(last.internalDate, now) });
      continue;
    }
    const sentAt = iso(last.internalDate, now);
    if (now.getTime() - Date.parse(sentAt) < minDays * 86_400_000) continue;
    const to = header(last.payload?.headers, "To").slice(0, 200);
    const from = header(last.payload?.headers, "From");
    // No-reply targets, and notes to self (same address, or your own name at another address).
    // Compared without accents: "Zoé Lefèvre" and "Zoe Lefevre" are the same person.
    const name = (v: string) => v.replace(/<[^>]*>/, "").replace(/["']/g, "").normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase();
    if (!to || AUTOMATED.test(to) || (email(to) && email(to) === email(from)) || (name(to) && name(to) === name(from))) continue;
    rows.push({
      thread_id: t.id,
      recipient: to,
      subject: header(last.payload?.headers, "Subject").slice(0, 300) || "(no subject)",
      sent_at: sentAt,
      rfc_message_id: header(last.payload?.headers, "Message-ID").match(/^<[^<>\s]{3,250}>$/)?.[0] ?? null,
    });
  }
  // A nudge is a Gmail draft created after your approval; an answer that arrives after it revives the thread.
  const nudges = new Map(
    all<{ key: string; executed_at: string }>(ctx.db, "SELECT idempotency_key AS key, executed_at FROM actions WHERE status = 'executed' AND idempotency_key LIKE 'nudge:%' AND is_demo = 0").map((a) => [a.key.split(":")[1], a.executed_at]),
  );
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM waiting_on WHERE is_demo = 0");
    for (const r of rows) run(ctx.db, "INSERT INTO waiting_on (thread_id, recipient, subject, sent_at, rfc_message_id, is_demo) VALUES (?, ?, ?, ?, ?, 0)", r.thread_id, r.recipient, r.subject, r.sent_at, r.rfc_message_id);
    for (const a of answered) {
      const nudgedAt = nudges.get(a.thread_id);
      if (nudgedAt && a.at > nudgedAt) run(ctx.db, "INSERT OR IGNORE INTO revived_threads (thread_id, nudged_at, answered_at, is_demo) VALUES (?, ?, ?, 0)", a.thread_id, nudgedAt, a.at);
    }
  });
  setSetting(ctx.db, "insights.scanned.waiting", now.toISOString());
  notifyNewItems(ctx, "waiting", rows.map((r) => ({ key: r.thread_id, detail: `${r.subject} (to ${r.recipient.replace(/\s*<[^>]*>/, "")})` })), "Still no answer", (n) => `${n} conversation(s) still waiting on a reply.`);
  return { threads: threadIds.length, waiting: rows.length };
}

// English, French, Spanish and Catalan. `\b` fails next to accented letters, so word lists use
// explicit Unicode letter boundaries.
const words = (alts: string, prefix = false) => new RegExp(`(?<!\\p{L})(?:${alts})${prefix ? "" : "(?!\\p{L})"}`, "iu");

// Subjects Gmail matches server-side; promotions are excluded.
const BOOKING_QUERY =
  "newer_than:180d -category:promotions {" +
  [
    "flight", "booking", "reservation", "itinerary", "ticket", '"check-in"', "confirmation", "confirmed", "trip", "boarding", "hotel",
    "réservation", "billet", "vol", "embarquement", "enregistrement", "voyage", "séjour",
    "reserva", "billete", "vuelo", "embarque", "viaje", "alojamiento", "confirmación",
    "bitllet", "embarcament", "viatge", "allotjament", "confirmació",
  ]
    .map((w) => `subject:${w}`)
    .join(" ") +
  "}";
const KINDS: [string, RegExp][] = [
  // Before "train": a rental desk "at Central Train Station" is still a car.
  ["car", words("car rental|car hire|rental car|rent a car|location de voiture|loueur|alquiler de coche|alquiler de vehículo|lloguer de cotxe|record\\+go|goldcar|europcar|hertz|sixt|avis budget|enterprise rent|cicar|ok ?mobility|centauro")],
  ["flight", words("flight|boarding|e-?ticket|airline|ryanair|easyjet|vueling|volotea|wizz ?air|transavia|air ?france|lufthansa|klm|iberia|british airways|norwegian|tap air|swiss|ita airways|air europa|binter|vol|embarquement|enregistrement en ligne|vuelo|tarjeta de embarque|aerolínea|targeta d'embarcament|aerolínia")],
  ["train", words("train|sncf|ouigo|tgv|inoui|eurostar|trainline|renfe|avlo|iryo|rodalies|fgc|db bahn|thalys|italo|trenitalia|billet de train|tren|billete de tren|bitllet de tren")],
  ["stay", words("hotel|hôtel|booking\\.com|airbnb|accommodation|hébergement|logement|séjour|stay|check-?in|hostel|alojamiento|estancia|apartamento|allotjament|estada|apartament|hostal")],
  ["table", words("restaurant|restaurante|thefork|opentable|lafourchette|eltenedor|dinner reservation|réservation de table|reserva de mesa|reserva de taula")],
  ["event", words("ticket|billet|entradas?|entrades|concert|concierto|festival|museum|musée|museo|museu|spectacle|espectáculo|espectacle|show|cinema|cinéma|cine|match|partido|partit")],
];
/** Words that make a subject a booking on their own (prefixes: "reserv" covers reserva/reservado/reservat). */
const STRONG = words("booking|booked|reservation|reserved|itinerary|e-?ticket|boarding|check-?in|your trip|réservation|réservé|billet|bitllet|embarquement|embarque|embarcament|enregistrement|itinéraire|itinerario|itinerari|votre voyage|tu viaje|el teu viatge|reserva", true);
/** "Confirmed" alone also fits shop orders and bank transfers: it only counts with a travel/booking kind. */
const WEAK = words("confirm|confirmée?|confirmación|confirmad[oa]|confirmació|confirmat|confirmada", true);
/** Orders, payments and deliveries aren't trips unless a travel kind says otherwise (e.g. a train ticket order). */
const NOT_TRIP = words("bénéficiaire|beneficiary|beneficiario|beneficiari|order|commande|pedido|comanda|payment|paiement|pago|pagament|virement|transfer|transferencia|transferència|invoice|facture|factura|receipt|reçu|recibo|rebut|subscription|abonnement|suscripción|subscripció|delivery|livraison|entrega|lliurament|shipped|expédiée?|enviado|enviat");

/** Never a trip, whoever sends it (booking.com also sends sign-in codes; insurers send policies). */
const NEVER_TRIP = words("verification code|one-time code|sign-in code|código de verificación|code de vérification|codi de verificació|insurance|assurance|seguro de|póliza|poliza|pòlissa|your password|contraseña|mot de passe");

/** Booking confirmations from the last 6 months. */
export async function scanBookings(ctx: Ctx, fetcher: Fetcher = fetch) {
  // Trips are booked months ahead, and the subject words also match other confirmations: look back
  // 6 months and far enough (up to 150, headers only) that newer mail doesn't push a flight out.
  const ids = await listIds(ctx, BOOKING_QUERY, 150, fetcher);
  const msgs = await pool(ids, 4, (id) => gmailGet<GmailMessage>(ctx, metadataUrl(id, ["From", "Subject"]), fetcher));
  const rows = msgs.flatMap((m) => {
    const subject = header(m.payload?.headers, "Subject").slice(0, 300);
    const sender = header(m.payload?.headers, "From").slice(0, 200);
    if (m.labelIds?.includes("CATEGORY_PROMOTIONS") || NEVER_TRIP.test(subject)) return [];
    const typed = KINDS.find(([, re]) => re.test(`${subject} ${sender}`))?.[0];
    const isBooking = typed ? STRONG.test(subject) || WEAK.test(subject) : STRONG.test(subject) && !NOT_TRIP.test(subject);
    if (!isBooking) return [];
    const kind = typed ?? "booking";
    return [{ id: `gm_${m.id}`, kind, sender: sender || "(unknown sender)", subject, received_at: iso(m.internalDate, ctx.now()) }];
  });
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM bookings WHERE is_demo = 0");
    for (const r of rows) run(ctx.db, "INSERT OR REPLACE INTO bookings (id, kind, sender, subject, received_at, is_demo) VALUES (?, ?, ?, ?, ?, 0)", r.id, r.kind, r.sender, r.subject, r.received_at);
  });
  setSetting(ctx.db, "insights.scanned.bookings", ctx.now().toISOString());
  notifyNewItems(ctx, "booking", rows.map((r) => ({ key: r.id, detail: r.subject })), "Trip or booking found", (n) => `${n} new booking confirmation(s) in your mail.`);
  return { scanned: ids.length, bookings: rows.length };
}

const PAID = words(
  "receipt|invoice|payment|paid|renew(?:al|s|ed)?|subscription|billing|billed|charged|your order|trial|membership|premium|" +
    "reçu|facture|paiement|prélèvement|abonnement|renouvellement|" +
    "recibo|factura|pago|cargo|cobro|suscripción|renovación|cuota|" +
    "rebut|pagament|càrrec|subscripció|renovació|quota",
);
/** Gmail search for mail you can unsubscribe from, in the four languages. */
const UNSUBSCRIBE_QUERY = 'newer_than:120d {unsubscribe "se désabonner" désabonnement désinscription "darse de baja" "dar de baja" "cancelar suscripción" "donar-se de baixa" "cancel·lar la subscripció"}';

/** Senders of mail you can unsubscribe from over the last 4 months, most frequent first. */
/** Up to this many recent messages are read (headers only) per audit: ~45 s, well within Gmail's quota. */
const AUDIT_MAX_MESSAGES = 300;

export async function auditSubscriptions(ctx: Ctx, fetcher: Fetcher = fetch) {
  const ids = await listIds(ctx, UNSUBSCRIBE_QUERY, AUDIT_MAX_MESSAGES, fetcher);
  const msgs = await pool(ids, 4, (id) => gmailGet<GmailMessage>(ctx, metadataUrl(id, ["From", "Subject", "List-Unsubscribe"]), fetcher));
  const bySender = new Map<string, { name: string; messages: number; last_seen: string; looks_paid: boolean; can_unsubscribe: boolean }>();
  for (const m of msgs) {
    const from = header(m.payload?.headers, "From");
    const addr = email(from);
    if (!addr) continue;
    const when = iso(m.internalDate, ctx.now());
    const cur = bySender.get(addr) ?? { name: from.replace(/<[^>]*>/, "").replace(/"/g, "").trim().slice(0, 120) || addr, messages: 0, last_seen: when, looks_paid: false, can_unsubscribe: false };
    cur.messages++;
    if (when > cur.last_seen) cur.last_seen = when;
    cur.looks_paid ||= PAID.test(header(m.payload?.headers, "Subject"));
    cur.can_unsubscribe ||= !!header(m.payload?.headers, "List-Unsubscribe");
    bySender.set(addr, cur);
  }
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM subscriptions WHERE is_demo = 0");
    for (const [sender, s] of bySender) {
      run(ctx.db, "INSERT INTO subscriptions (sender, name, messages, last_seen, looks_paid, can_unsubscribe, is_demo) VALUES (?, ?, ?, ?, ?, ?, 0)", sender, s.name, s.messages, s.last_seen, s.looks_paid ? 1 : 0, s.can_unsubscribe ? 1 : 0);
    }
  });
  setSetting(ctx.db, "insights.scanned.subscriptions", ctx.now().toISOString());
  return { scanned: ids.length, senders: bySender.size };
}
