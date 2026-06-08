/*
 * src/lib/ses.js
 * Cliente Amazon SES para campañas de correo.
 *
 * Arquitectura:
 *   nodemailer (stream transport)  →  construye el MIME multipart
 *           ↓                         (incluye attachments inline con CID)
 *   buffer del raw MIME
 *           ↓
 *   SES v2 SendEmailCommand con Content.Raw  →  envía
 *
 * Por qué este split: nodemailer es la herramienta estándar para armar
 * multipart MIME correcto con inline CID, pero su SES transport directo
 * solo soporta SES v1 (cliente legacy). Usándolo como stream-builder y
 * mandando el raw via SES v2, obtenemos lo mejor de ambos.
 *
 * IMPORTANTE: este módulo extrae automáticamente <img src="data:image/...">
 * del HTML y los convierte a adjuntos inline (cid:imgN). Esto es lo que
 * permite que Gmail, Outlook, Apple Mail rendericen las imágenes pegadas
 * por el cliente — base64 inline es bloqueado por Gmail desde 2014.
 *
 * Credenciales en process.env: AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, SES_DEFAULT_FROM.
 */
"use strict";

const {
  SESv2Client,
  SendEmailCommand,
} = require("@aws-sdk/client-sesv2");
const nodemailer = require("nodemailer");

let _sesClient = null;
let _mimeBuilder = null;

function getSesClient() {
  if (_sesClient) return _sesClient;
  const region = process.env.AWS_REGION || "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  _sesClient = new SESv2Client({
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
  return _sesClient;
}

function getMimeBuilder() {
  if (_mimeBuilder) return _mimeBuilder;
  // streamTransport=true hace que nodemailer NO envíe, solo construya
  // el MIME y lo entregue como stream. Ideal para delegar el send a SES.
  _mimeBuilder = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true, // pedimos buffer en vez de stream → más fácil de manejar
  });
  return _mimeBuilder;
}

/**
 * Extrae <img src="data:image/...;base64,..."> del HTML y los reemplaza
 * por <img src="cid:imgN">, devolviendo además el array de adjuntos inline
 * en el formato que nodemailer espera.
 */
function extractInlineImages(html) {
  if (typeof html !== "string" || !html.includes("data:image")) {
    return { html: html || "", attachments: [] };
  }

  const attachments = [];
  const dataUrlRegex =
    /<img([^>]*?)src=["'](data:image\/([a-zA-Z0-9+.-]+);base64,([^"']+))["']([^>]*)>/gi;

  let counter = 0;
  const newHtml = html.replace(
    dataUrlRegex,
    (_match, before, _fullDataUrl, mime, b64, after) => {
      counter += 1;
      const cid = `img-${counter}-${Date.now().toString(36)}`;
      const cleanB64 = String(b64).replace(/\s+/g, "");
      let buffer;
      try {
        buffer = Buffer.from(cleanB64, "base64");
      } catch (_) {
        return `<img${before}src="data:image/${mime};base64,${b64}"${after}>`;
      }
      attachments.push({
        cid,
        filename: `inline-${counter}.${normalizeExt(mime)}`,
        content: buffer,
        contentType: `image/${normalizeExt(mime)}`,
        contentDisposition: "inline",
      });
      return `<img${before}src="cid:${cid}"${after}>`;
    },
  );

  return { html: newHtml, attachments };
}

function normalizeExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "jpg" || m === "jpeg") return "jpeg";
  if (m === "png") return "png";
  if (m === "gif") return "gif";
  if (m === "webp") return "webp";
  if (m === "svg+xml" || m === "svg") return "svg+xml";
  return "jpeg";
}

/**
 * Construye el raw MIME del correo usando nodemailer.
 * Devuelve un Buffer listo para SES.SendEmailCommand con Content.Raw.
 */
function buildRawMime(mailOptions) {
  return new Promise((resolve, reject) => {
    getMimeBuilder().sendMail(mailOptions, (err, info) => {
      if (err) return reject(err);
      if (!info?.message) return reject(new Error("nodemailer no devolvió message buffer"));
      resolve(info.message);
    });
  });
}

/**
 * Envía un correo individual.
 *
 * @param {object} args
 * @param {string} args.from
 * @param {string} args.to
 * @param {string} args.subject
 * @param {string} [args.html]    Puede incluir <img src="data:image/...">.
 * @param {string} [args.text]
 * @param {string} [args.replyTo]
 * @returns {Promise<{ok, messageId, error, code, inlineImages}>}
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

  // 1) Extraer imágenes base64 → adjuntos inline CID.
  const { html: htmlWithCids, attachments } = extractInlineImages(html || "");

  const mailOptions = {
    from: sender,
    to,
    subject,
    ...(text ? { text } : {}),
    ...(htmlWithCids ? { html: htmlWithCids } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  try {
    // 2) Construir raw MIME (nodemailer arma el multipart/related correcto).
    const rawMime = await buildRawMime(mailOptions);

    // 3) Enviar vía SES v2 con Content.Raw.
    const sesClient = getSesClient();
    const cmd = new SendEmailCommand({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [to] },
      Content: {
        Raw: {
          Data: rawMime,
        },
      },
    });
    const resp = await sesClient.send(cmd);
    return {
      ok: true,
      messageId: resp?.MessageId || null,
      inlineImages: attachments.length,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Error SES desconocido",
      code: err?.name || err?.Code || "SES_ERROR",
    };
  }
}

module.exports = {
  getSesClient,
  sendOneEmail,
  extractInlineImages,
  buildRawMime,
};
