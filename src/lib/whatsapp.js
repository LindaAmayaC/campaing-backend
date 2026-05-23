// Utilidades para construir/normalizar payloads de WhatsApp.
// Aisladas para poder testearlas sin depender del DOM ni de Express.

/**
 * Normaliza un teléfono para WhatsApp Cloud API. Devuelve solo dígitos
 * (formato E.164 sin el "+"). Acepta cualquier país siempre que el formato
 * sea claro. Devuelve "" si no se puede determinar inequívocamente.
 *
 * Reglas (en orden):
 *  1. Con "+": confiamos en el código de país, validamos 8-15 dígitos.
 *  2. Sin "+", 10 dígitos empezando por 3: Colombia → prefijamos 57.
 *  3. Sin "+", 11-15 dígitos: asumimos que ya incluye código de país.
 *  4. Cualquier otro caso: vacío.
 */
function normalizeWhatsappRecipient(phone) {
  const trimmed = String(phone || "").trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return digits;
    return "";
  }

  const digitsOnly = trimmed.replace(/\D/g, "");

  if (digitsOnly.length === 10 && /^3\d{9}$/.test(digitsOnly)) {
    return "57" + digitsOnly;
  }

  if (digitsOnly.length >= 11 && digitsOnly.length <= 15) {
    return digitsOnly;
  }

  return "";
}

// Alias legacy: el normalizador anterior era específico de Colombia.
// La nueva versión cubre todos los casos previos y añade soporte internacional.
const normalizeWhatsappRecipientColombia = normalizeWhatsappRecipient;

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
  normalizeWhatsappRecipient,
  normalizeWhatsappRecipientColombia, // alias legacy
  getTemplateBodyText,
  buildTemplateParameters,
};
