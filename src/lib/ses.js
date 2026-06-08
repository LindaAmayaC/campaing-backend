/*
 * src/lib/ses.js
 * Cliente Amazon SES v2 reutilizable para el endpoint de campañas Email.
 *
 * Lee credenciales desde process.env (AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY). SES_DEFAULT_FROM se usa cuando el body no manda
 * un `from` explícito.
 *
 * Estrategia: un SendEmailCommand por destinatario (loop a nivel del
 * server.js con p-limit). Esto permite reportar errores individuales,
 * personalizar más adelante y respetar el rate limit de SES (1 req/seg
 * en sandbox, ~14 req/seg en producción).
 */
"use strict";

const {
  SESv2Client,
  SendEmailCommand,
} = require("@aws-sdk/client-sesv2");

let _client = null;

function getSesClient() {
  if (_client) return _client;
  const region = process.env.AWS_REGION || "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  // Si las claves están en env las usamos explícitamente; si no, el SDK
  // intenta la cadena de credenciales por defecto (perfil, role, etc.).
  const config = { region };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  _client = new SESv2Client(config);
  return _client;
}

/**
 * Envía un correo individual vía SES v2.
 *
 * @param {object} args
 * @param {string} args.from        Remitente (override de SES_DEFAULT_FROM).
 * @param {string} args.to          Destinatario.
 * @param {string} args.subject     Asunto.
 * @param {string} [args.html]      HTML body.
 * @param {string} [args.text]      Plain-text body.
 * @param {string} [args.replyTo]   Reply-To opcional.
 * @returns {Promise<{ok:boolean, messageId?:string, error?:string, code?:string}>}
 */
async function sendOneEmail({ from, to, subject, html, text, replyTo }) {
  const sender =
    (from && String(from).trim()) ||
    (process.env.SES_DEFAULT_FROM && String(process.env.SES_DEFAULT_FROM).trim()) ||
    "";

  if (!sender) {
    return {
      ok: false,
      error: "SES_DEFAULT_FROM no configurado y no llegó 'from' en el body.",
      code: "MISSING_FROM",
    };
  }
  if (!to || typeof to !== "string") {
    return { ok: false, error: "Destinatario inválido", code: "INVALID_TO" };
  }
  if (!subject || typeof subject !== "string") {
    return { ok: false, error: "Asunto requerido", code: "INVALID_SUBJECT" };
  }
  if (!html && !text) {
    return {
      ok: false,
      error: "Debes enviar al menos uno de: html, text",
      code: "EMPTY_BODY",
    };
  }

  const body = {};
  if (html) body.Html = { Data: html, Charset: "UTF-8" };
  if (text) body.Text = { Data: text, Charset: "UTF-8" };

  const command = new SendEmailCommand({
    FromEmailAddress: sender,
    Destination: { ToAddresses: [to] },
    ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: body,
      },
    },
  });

  try {
    const client = getSesClient();
    const resp = await client.send(command);
    return { ok: true, messageId: resp?.MessageId || null };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Error SES desconocido",
      code: err?.name || err?.Code || "SES_ERROR",
    };
  }
}

module.exports = { getSesClient, sendOneEmail };
