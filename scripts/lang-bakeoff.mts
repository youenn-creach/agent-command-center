import "./_env.mts";
import { fenceUntrusted } from "@/server/llm";
import { draftSystemPrompt, parseDraft } from "@/server/agents/chiefOfStaff";
import { detectLanguage, type Lang } from "@/server/lang";
import { unloadAllModels } from "@/server/llmRuntime";

/**
 * Compares local models on fictional reply drafts in Catalan, Spanish and French, with the same prompt
 * as the app. Usage: npx tsx scripts/lang-bakeoff.mts <model> [<model>…]  (reads no user data)
 */
// Fictional emails only. Same prompt as the app (rules + instruction in the email's language + About me).
const EMAILS: { from: string; subject: string; text: string }[] = [
  { from: "Jordi <jordi@example.com>", subject: "Excursió dissabte", text: "Hola! Dissabte anem a fer la ruta de Montserrat, sortim a les vuit des de l'estació. Pots portar el mapa i dir-me abans de dijous si vens? Gràcies, Jordi" },
  { from: "Marta <marta@example.com>", subject: "Pressupost de la cuina", text: "Bon dia, t'envio el pressupost per a les prestatgeries de la cuina: 1.250 €, instal·lació inclosa. Em pots confirmar si et va bé abans de divendres? Salutacions, Marta" },
  { from: "Laia <laia@example.com>", subject: "Sopar d'aniversari", text: "Ei! Dissabte que ve faig 30 anys i organitzo un sopar a casa meva a les nou. T'hi apuntes? Porta només ganes de festa! Una abraçada, Laia" },
  { from: "Lucía <lucia@example.com>", subject: "¿Cena el viernes?", text: "¡Hola! Organizamos una cena en casa el viernes a las nueve. ¿Te apuntas? Dime si tienes alguna alergia. Un abrazo, Lucía" },
  { from: "Julien <julien@example.com>", subject: "Dîner vendredi ?", text: "Salut ! On organise un dîner chez nous vendredi soir vers 20h. Tu peux venir ? Dis-moi si tu as des allergies. Bises, Julien" },
];
const about = "About the user (written by the user themselves; follow these preferences):\n- I sign emails as Sam";

async function chat(model: string, system: string, user: string) {
  const t0 = performance.now();
  const res = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(400_000),
    body: JSON.stringify({ model, stream: false, keep_alive: "2m", ...(model.startsWith("qwen3") ? { think: false } : {}), messages: [{ role: "system", content: system }, { role: "user", content: user }], options: { temperature: 0.2, num_ctx: 4096, num_predict: 300 } }),
  });
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  return { text: body.message?.content ?? "", s: (performance.now() - t0) / 1000 };
}

for (const model of process.argv.slice(2)) {
  console.log(`\n================ ${model}`);
  for (const e of EMAILS) {
    const lang = detectLanguage(e.text) as Lang;
    const system = draftSystemPrompt(lang, about, e.from); // exactly the app's prompt
    try {
      const out = await chat(model, system, fenceUntrusted(`email from ${e.from}`, `Subject: ${e.subject}\n\n${e.text}`));
      const d = parseDraft(out.text);
      const got = d ? detectLanguage(d.reply) : null;
      console.log(`--- [${lang}] ${e.subject} · ${out.s.toFixed(0)} s · ${d ? `reply language: ${got ?? "?"}` : "UNPARSEABLE"}\n${d ? d.reply : out.text.slice(0, 400)}\n`);
    } catch (err) {
      console.log(`--- [${lang}] ${e.subject} · FAILED: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  await unloadAllModels();
}
