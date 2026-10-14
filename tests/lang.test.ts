import { describe, expect, it } from "vitest";
import { detectLanguage, holdingReplyIn } from "@/server/lang";

describe("language detection", () => {
  it.each([
    ["en", "Hi! We're planning the ridge loop on Saturday, leaving at 8am from the station. Can you bring the map, and let me know by Thursday if you're coming?"],
    ["fr", "Salut ! On organise un dîner chez nous vendredi soir vers 20h. Tu peux venir ? Dis-moi si tu as des allergies. Bises, Julien"],
    ["es", "¡Hola! Organizamos una cena en casa el viernes a las nueve. ¿Te apuntas? Dime si tienes alguna alergia. Un abrazo, Lucía"],
    ["ca", "Hola! Dissabte anem a fer la ruta de Montserrat, sortim a les vuit des de l'estació. Pots portar el mapa i dir-me abans de dijous si vens? Gràcies, Jordi"],
    ["ca", "Bon dia, t'envio el pressupost per a les prestatgeries de la cuina. Em pots confirmar si et va bé abans de divendres? Salutacions, Marta"],
    ["es", "Buenos días, te envío el presupuesto para las estanterías de la cocina. ¿Me puedes confirmar si te va bien antes del viernes? Saludos, Marta"],
    ["ca", "Moltes gràcies per la invitació, però aquest cap de setmana no podré venir perquè tinc feina."],
    ["es", "Muchas gracias por la invitación, pero este fin de semana no podré ir porque tengo trabajo."],
    ["fr", "Merci beaucoup pour l'invitation, mais ce week-end je ne pourrai pas venir car je travaille."],
  ])("%s: %s", (lang, text) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it("doesn't guess on very short or empty text", () => {
    expect(detectLanguage("OK")).toBeNull();
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("12/10 18:00")).toBeNull();
  });

  it("writes the holding reply in the email's language", () => {
    expect(holdingReplyIn("ca", "Jordi")).toMatch(/^Hola Jordi,\n\nGràcies pel teu missatge/);
    expect(holdingReplyIn("es", null)).toMatch(/^Hola,\n\nGracias por tu mensaje/);
    expect(holdingReplyIn(null, "Ana")).toMatch(/^Hi Ana,/);
  });
});
