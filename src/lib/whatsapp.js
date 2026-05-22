// Utilidades para construir/normalizar payloads de WhatsApp.
// Aisladas para poder testearlas sin depender del DOM ni de Express.

/**
 * Normaliza un teléfono a formato Colombia para WhatsApp Cloud API:
 * "57" + 10 dígitos nacionales. Devuelve "" si no es válido.
 */
function normalizeWhatsappRecipientColombia(phone) {
  const trimmed = String(phone || "").trim();
  const digitsOnly = trimmed.replace(/\D/g, "");

  if (digitsOnly.length === 12 && digitsOnly.startsWith("57")) return digitsOnly;
  if (digitsOnly.length === 10 && /^3\d{9}$/.test(digitsOnly)) {
    return "57" + digitsOnly;
  }
  if (/^\+57\d{10}$/.test(trimmed)) {
    return "57" + trimmed.slice(3).replace(/\D/g, "");
  }
  return "";
}

/**
 * Lee el texto del componente BODY de una plantilla de Meta.
 */
function getTemplateBodyText(template) {
  if (!template) return "";
  const body = (template.components || []).find(
    (c) => String(c?.type || "").toUpperCase() === "BODY",
  );
  return String(body?.text || "").trim();
}

/**
 * Construye los parámetros del componente BODY mapeando los placeholders
 * {{nombre}}/{{1}} y {{destino}}/{{2}} del template a los valores recibidos.
 */
function buildTemplateParameters(bodyText, contactName, campanaNombre) {
  const matches = [...String(bodyText || "").matchAll(/{{\s*([^}]+)\s*}}/g)];
  if (!matches.length) return [];

  const name = String(contactName || "Cliente").trim();
  const camp = String(campanaNombre || "Campana").trim();
  const params = [];

  for (const match of matches) {
    const token = String(match[1] || "").trim().toLowerCase();
    if (token === "1" || token === "nombre") {
      params.push({
        type: "text",
        parameter_name: "nombre",
        text: name || "Cliente",
      });
      continue;
    }
    if (token === "2" || token === "destino") {
      params.push({
        type: "text",
        parameter_name: "destino",
        text: camp || "Campana",
      });
      continue;
    }
  }
  return params;
}

module.exports = {
  normalizeWhatsappRecipientColombia,
  getTemplateBodyText,
  buildTemplateParameters,
};
