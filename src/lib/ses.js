/*
 * src/lib/ses.js
 * Cliente Amazon SES para campañas de correo con CID inline.
 *
 * Arquitectura:
 *   Frontend → HTML con <img src="data:image/...">
 *       ↓
 *   extractInlineImages: data: → cid:imgN + buffer separado
 *       ↓
 *   buildMimeRaw: arma multipart/alternative > multipart/related con
 *                 la estructura EXACTA que usan Mailchimp/Sendgrid (sin
 *                 filename/name params que confunden a Gmail).
 *       ↓
 *   SES v2 SendEmailCommand con Content.Raw
 *
 * Por qué no nodemailer: nodemailer siempre agrega filename y name a las
 * partes de imagen aunque no se los pidas. Gmail trata cualquier parte
 * con filename como adjunto descargable y NO renderiza el cid: en el HTML.
 * Por eso construimos el MIME a mano.
 *
 * Credenciales en process.env: AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, SES_DEFAULT_FROM.
 */
"use strict";

const crypto = require("crypto");
const {
  SESv2Client,
  SendEmailCommand,
} = require("@aws-sdk/client-sesv2");

let _sesClient = null;

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

/**
 * Extrae <img src="data:image/...;base64,..."> del HTML y los reemplaza
 * por <img src="cid:imgN">. Devuelve también la lista de attachments con
 * cid, contentType y buffer.
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
      // CID estilo Mailchimp: id corto + dominio fake. Gmail acepta este
      // formato sin problemas. No usar guiones medios largos porque
      // algunos parsers antiguos los rompen.
      const cid = `img${counter}.${Date.now().toString(36)}@viajesyviajes`;
      const cleanB64 = String(b64).replace(/\s+/g, "");
      let buffer;
      try {
        buffer = Buffer.from(cleanB64, "base64");
      } catch (_) {
        return `<img${before}src="data:image/${mime};base64,${b64}"${after}>`;
      }
      attachments.push({
        cid,
        contentType: `image/${normalizeExt(mime)}`,
        buffer,
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

function randomBoundary(label) {
  return `${label}_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Codifica un header en MIME-encoded-word (RFC 2047) si contiene
 * caracteres no-ASCII. Necesario para Subject y From con tildes/emojis.
 */
function encodeHeader(value) {
  const s = String(value || "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/**
 * Wrap base64 cada 76 chars con CRLF (RFC 2045).
 */
function wrapBase64(b64) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/**
 * Construye el raw MIME del correo a mano, con control total sobre los
 * headers de cada parte. Replicamos el patrón que usan Mailchimp/Sendgrid
 * (sin filename ni name params en las partes de imagen).
 */
function buildMimeRaw({ from, to, subject, text, html, replyTo, attachments }) {
  const altBoundary = randomBoundary("alt");
  const relBoundary = randomBoundary("rel");
  const CRLF = "\r\n";
  const lines = [];

  // Headers principales del correo.
  lines.push(`From: ${encodeHeader(from)}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push("MIME-Version: 1.0");

  const hasInline = Array.isArray(attachments) && attachments.length > 0;
  const hasText = Boolean(text);
  const hasHtml = Boolean(html);

  if (hasText && hasHtml) {
    lines.push(
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    );
    lines.push("");

    // text/plain
    lines.push(`--${altBoundary}`);
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(text);
    lines.push("");

    if (hasInline) {
      // multipart/related con html + imágenes inline
      lines.push(`--${altBoundary}`);
      lines.push(
        `Content-Type: multipart/related; boundary="${relBoundary}"`,
      );
      lines.push("");

      lines.push(`--${relBoundary}`);
      lines.push("Content-Type: text/html; charset=utf-8");
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(html);
      lines.push("");

      for (const att of attachments) {
        lines.push(`--${relBoundary}`);
        // Ojo: sin name=, sin filename=, sin Content-Disposition con
        // filename. Solo lo estrictamente necesario.
        lines.push(`Content-Type: ${att.contentType}`);
        lines.push(`Content-Transfer-Encoding: base64`);
        lines.push(`Content-ID: <${att.cid}>`);
        lines.push(`Content-Disposition: inline`);
        lines.push("");
        lines.push(wrapBase64(att.buffer.toString("base64")));
        lines.push("");
      }
      lines.push(`--${relBoundary}--`);
      lines.push("");
    } else {
      // Solo HTML, sin imágenes
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=utf-8");
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(html);
      lines.push("");
    }

    lines.push(`--${altBoundary}--`);
    lines.push("");
  } else if (hasHtml && hasInline) {
    // Solo HTML + imágenes, sin text/plain.
    lines.push(
      `Content-Type: multipart/related; boundary="${relBoundary}"`,
    );
    lines.push("");
    lines.push(`--${relBoundary}`);
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(html);
    lines.push("");
    for (const att of attachments) {
      lines.push(`--${relBoundary}`);
      lines.push(`Content-Type: ${att.contentType}`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push(`Content-ID: <${att.cid}>`);
      lines.push(`Content-Disposition: inline`);
      lines.push("");
      lines.push(wrapBase64(att.buffer.toString("base64")));
      lines.push("");
    }
    lines.push(`--${relBoundary}--`);
    lines.push("");
  } else if (hasHtml) {
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(html);
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(text || "");
  }

  return Buffer.from(lines.join(CRLF), "utf8");
}

/**
 * Envía un correo individual.
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

  const { html: htmlWithCids, attachments } = extractInlineImages(html || "");

  let rawMime;
  try {
    rawMime = buildMimeRaw({
      from: sender,
      to,
      subject,
      text,
      html: htmlWithCids,
      replyTo,
      attachments,
    });
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Error construyendo MIME",
      code: "MIME_BUILD_ERROR",
    };
  }

  try {
    const sesClient = getSesClient();
    const cmd = new SendEmailCommand({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [to] },
      Content: {
        Raw: { Data: rawMime },
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
  buildMimeRaw,
};
