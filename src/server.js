require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const compression = require("compression");
const https = require("https");
const pLimit = require("p-limit").default;

const logger = require("./lib/logger");
const metrics = require("./lib/metrics");
const { sendOneEmail } = require("./lib/ses");
const db = require("./lib/db");

const app = express();

// Comprime respuestas JSON > 1KB con gzip/brotli (según lo que mande el
// cliente en Accept-Encoding). Útil sobre todo para el reporte de envío
// y la lista de plantillas, que pueden traer varios KB.
app.use(compression());

// Agent HTTPS con keep-alive: reutiliza la conexión TCP/TLS hacia Meta
// entre los miles de POST de una campaña. Sin esto, axios negocia un
// handshake nuevo por cada mensaje (~50-80ms extra).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 20,
});

const metaAxios = axios.create({
  httpsAgent: keepAliveAgent,
  timeout: 20000,
});

// Captura excepciones no manejadas y promesas rechazadas. Sin esto, una
// excepción asíncrona puede tumbar el proceso silenciosamente en Railway.
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { error: err?.message, stack: err?.stack });
  metrics.inc("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", {
    reason: reason?.message || String(reason),
  });
  metrics.inc("unhandledRejection");
});

// ===============================
// CORS BITRIX
// Acepta tanto el portal (viajesyviajes.bitrix24.es) como el CDN donde
// se sirven las "local apps" (apps-*.bitrix24-cdn.com).
// ===============================

const allowedOriginPatterns = [
  /^https:\/\/[a-z0-9-]+\.bitrix24\.es$/i,
  /^https:\/\/[a-z0-9-]+\.bitrix24-cdn\.com$/i,
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // peticiones server-to-server o curl
    const ok = allowedOriginPatterns.some((re) => re.test(origin));
    if (ok) return callback(null, true);
    logger.warn("cors.rejected", { origin });
    metrics.inc("cors.rejected");
    return callback(new Error("Origin no permitido: " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ===============================
// JSON
// ===============================

app.use(express.json({ limit: "50mb" }));

// ===============================
// AUTH POR API KEY
// Protege los endpoints que cuestan dinero (envío Meta) o exponen plantillas.
// Acepta X-Api-Key o Authorization: Bearer <key>.
// Si API_SECRET no está configurada en env, la auth queda OFF (modo dev).
// ===============================

const API_SECRET = process.env.API_SECRET || "";
const PROTECTED_PREFIXES = ["/apply-campaign/", "/whatsapp/"];

function requireApiKey(req, res, next) {
  if (!API_SECRET) return next(); // sin secret configurado → pasa (dev)
  const isProtected = PROTECTED_PREFIXES.some((p) => req.path.startsWith(p));
  if (!isProtected) return next();

  const headerKey =
    req.get("X-Api-Key") ||
    (req.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

  if (headerKey && headerKey === API_SECRET) return next();
  logger.warn("auth.rejected", { path: req.path, ip: req.ip });
  metrics.inc("auth.rejected");
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

app.use(requireApiKey);

// Concurrencia hacia Meta. Meta permite ~80 msg/seg por número;
// 15 paralelos con latencia ~300ms dan ~50 msg/seg, margen seguro.
const limit = pLimit(15);

// Reintentos para errores transitorios (429 rate limit / 5xx / red).
const MAX_RETRIES = 2;
const isRetriable = (err) => {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const code = err?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNABORTED";
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function postToMetaWithRetry(url, payload, token) {
  let attempt = 0;
  while (true) {
    try {
      const resp = await metaAxios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      return { ok: true, data: resp?.data };
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetriable(err)) {
        const backoff = 500 * Math.pow(2, attempt); // 500ms, 1s
        await wait(backoff);
        attempt += 1;
        continue;
      }
      return { ok: false, err };
    }
  }
}

// ===============================
// HOME
// ===============================

// Middleware de logging de request (ligero, sin body).
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    metrics.inc(`http.${res.statusCode}`);
    if (req.path !== "/health") {
      logger.info("http", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durMs: Date.now() - t0,
      });
    }
  });
  next();
});

app.get("/", (req, res) => {
  res.send("Backend funcionando");
});

// Métricas en memoria (no persistentes, se resetean por deploy).
app.get("/metrics", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    counters: metrics.snapshot(),
  });
});

// ===============================
// HEALTH / DIAGNÓSTICO
// Confirma sin exponer el valor si la env var WHATSAPP_TOKEN está cargada,
// muestra cuántos caracteres tiene y un prefijo corto para detectar typos.
// ===============================

app.get("/health", (req, res) => {
  const token = process.env.WHATSAPP_TOKEN || "";
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    env: {
      WHATSAPP_TOKEN_present: Boolean(token),
      WHATSAPP_TOKEN_length: token.length,
      WHATSAPP_TOKEN_prefix: token ? token.slice(0, 6) + "..." : null,
      WHATSAPP_WABA_ID_present: Boolean(process.env.WHATSAPP_WABA_ID),
      WHATSAPP_PHONE_NUMBER_ID_present: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
      API_SECRET_present: Boolean(process.env.API_SECRET),
      AWS_REGION_present: Boolean(process.env.AWS_REGION),
      AWS_ACCESS_KEY_ID_present: Boolean(process.env.AWS_ACCESS_KEY_ID),
      AWS_SECRET_ACCESS_KEY_present: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
      SES_DEFAULT_FROM_present: Boolean(process.env.SES_DEFAULT_FROM),
      DATABASE_URL_present: Boolean(process.env.DATABASE_URL),
      PORT: process.env.PORT || null,
      NODE_ENV: process.env.NODE_ENV || null,
    },
    db: { enabled: db.isEnabled() },
    cache: {
      sentEntries: sentCache.size,
    },
  });
});

// ===============================
// WHATSAPP TEMPLATES (proxy a Meta)
// GET /whatsapp/templates?wabaId=XXX
// Si no llega wabaId en query, usa process.env.WHATSAPP_WABA_ID.
// ===============================

app.get("/whatsapp/templates", async (req, res) => {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: "WHATSAPP_TOKEN no configurado." });
  }
  const wabaId = String(req.query.wabaId || process.env.WHATSAPP_WABA_ID || "").trim();
  if (!wabaId) {
    return res.status(400).json({ ok: false, error: "Falta wabaId (query o env)." });
  }

  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(
    wabaId,
  )}/message_templates?fields=name,status,language,category,components&limit=50`;

  try {
    const r = await metaAxios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const list = Array.isArray(r.data?.data) ? r.data.data : [];
    return res.json({ ok: true, count: list.length, data: list });
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg =
      err?.response?.data?.error?.message ||
      err?.message ||
      "Error consultando plantillas";
    logger.error("templates.failed", { status, msg });
    metrics.inc("templates.failed");
    return res.status(status).json({ ok: false, error: msg });
  }
});

// ===============================
// CACHE DE IDEMPOTENCIA
// Evita re-enviar el mismo número en la misma campaña (clave: campaignId|to).
// TTL 24h. GC cada hora.
// Solo memoria del proceso (1 instancia Railway = OK).
// ===============================

const sentCache = new Map(); // "campaignId|to" -> timestamp ms
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

function sentKey(campaignId, to) {
  return `${campaignId}|${to}`;
}
function alreadySent(campaignId, to) {
  const k = sentKey(campaignId, to);
  const ts = sentCache.get(k);
  if (!ts) return false;
  if (Date.now() - ts > SENT_TTL_MS) {
    sentCache.delete(k);
    return false;
  }
  return true;
}
function markSent(campaignId, to) {
  sentCache.set(sentKey(campaignId, to), Date.now());
}

setInterval(() => {
  const cutoff = Date.now() - SENT_TTL_MS;
  let purged = 0;
  for (const [k, ts] of sentCache.entries()) {
    if (ts < cutoff) {
      sentCache.delete(k);
      purged += 1;
    }
  }
}, 60 * 60 * 1000).unref();

// ===============================
// APPLY CAMPAIGN - SMS (relay a Onmall / messaging-service)
// ===============================
//
// Espera body:
// {
//   mensaje: "texto",
//   destinos: ["57XXXXXXXXXX", ...],
//   sendAt: "2026-05-21T10:00:00.000-05:00"  // opcional
// }
//
// Credenciales en process.env.ONMALL_AUTH (formato "Basic <base64>").
// process.env.ONMALL_FROM define el remitente; default "CompanyName".

app.post("/apply-campaign/sms", async (req, res) => {
  const onmallAuth = process.env.ONMALL_AUTH;
  if (!onmallAuth) {
    return res
      .status(500)
      .json({ ok: false, error: "ONMALL_AUTH no configurado en el servidor." });
  }

  const { mensaje, destinos, sendAt, campaignId, campaignName } = req.body || {};
  if (!mensaje || typeof mensaje !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "Falta mensaje (string) en el body." });
  }
  if (!Array.isArray(destinos) || destinos.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: "destinos debe ser un array no vacío." });
  }

  const payload = {
    messages: [
      {
        from: process.env.ONMALL_FROM || "CompanyName",
        destinations: destinos.map((to) => ({ to: String(to) })),
        text: mensaje,
        ...(sendAt ? { sendAt } : {}),
      },
    ],
  };

  try {
    const r = await axios.post(
      "https://api.messaging-service.com/sms/1/text/advanced",
      payload,
      {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: onmallAuth.startsWith("Basic ")
            ? onmallAuth
            : `Basic ${onmallAuth}`,
        },
        timeout: 20000,
      },
    );
    console.log(`[apply-campaign/sms] enviados ${destinos.length} destinos`);

    // --- Persistencia de tracking (best-effort) ---
    // Infobip devuelve data.messages[] con { to, messageId, status{...} }.
    // Guardamos una fila por destino con su messageId para cruzar luego el
    // reporte de entrega (DLR / polling).
    try {
      const trackId = String(campaignId || "sms-adhoc");
      await db.upsertCampaign(trackId, campaignName);
      const respMsgs = Array.isArray(r.data?.messages) ? r.data.messages : [];
      // Mapa to -> {messageId, status} para casar con la lista original.
      const byTo = new Map();
      for (const m of respMsgs) {
        if (m && m.to) byTo.set(String(m.to), m);
      }
      const rows = destinos.map((to) => {
        const m = byTo.get(String(to)) || {};
        const groupName = m?.status?.groupName || "";
        // Grupos Infobip: PENDING/DELIVERED = aceptado; REJECTED/UNDELIVERABLE = fallo.
        const rejected = /REJECTED|UNDELIVERABLE/i.test(groupName);
        return {
          campaignId: trackId,
          channel: "sms",
          recipient: String(to),
          recipientName: null,
          providerMessageId: m.messageId || null,
          sendStatus: rejected ? "failed" : "accepted",
          sendError: rejected
            ? m?.status?.name || m?.status?.description || groupName
            : null,
          providerRaw: m?.status ? { status: m.status } : null,
        };
      });
      await db.insertMessages(rows);
    } catch (e) {
      logger.error("sms.persist.failed", { error: e?.message });
    }

    return res.json({ ok: true, sent: destinos.length, data: r.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg =
      err?.response?.data?.requestError?.serviceException?.text ||
      err?.response?.data?.error ||
      err?.message ||
      "Error enviando SMS";
    console.error("[apply-campaign/sms] error:", msg);
    return res.status(status).json({ ok: false, error: msg });
  }
});

// ===============================
// APPLY CAMPAIGN - WHATSAPP (relay)
// ===============================
//
// Espera body:
// {
//   campaignId: "Verano2026-2026-05-21",        // identificador estable de la campaña
//   phoneNumberId: "990605564142727",
//   messages: [
//     { to: "57XXXXXXXXXX", payload: { messaging_product, to, type, template, ... } },
//     ...
//   ]
// }
//
// Si un (campaignId|to) ya fue enviado con éxito en las últimas 24h, se
// salta y se reporta como `duplicate`. Esto protege contra dobles clicks,
// reintentos del frontend o re-applies accidentales.

app.post("/apply-campaign/whatsapp", async (req, res) => {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    return res
      .status(500)
      .json({ ok: false, error: "WHATSAPP_TOKEN no configurado en el servidor." });
  }

  const { campaignId, campaignName, messages } = req.body || {};
  // phoneNumberId: prefiere env (recomendado); body solo como override.
  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID || req.body?.phoneNumberId || "";

  if (!campaignId || typeof campaignId !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "Falta campaignId (string) en el body." });
  }
  if (!phoneNumberId) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "Falta phoneNumberId (configura WHATSAPP_PHONE_NUMBER_ID en env).",
      });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: "messages debe ser un array no vacío." });
  }

  const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`;

  logger.info("wa.batch.start", { campaignId, batchSize: messages.length });

  const results = { ok: true, sent: 0, duplicates: 0, errors: [] };
  const trackRows = []; // filas para persistir (best-effort)

  const jobs = messages.map((msg) =>
    limit(async () => {
      const to = msg?.to || msg?.payload?.to || "desconocido";
      const payload = msg?.payload;
      if (!payload) {
        results.ok = false;
        results.errors.push(`(${to}) payload vacío`);
        return;
      }

      // Idempotencia: si ya se envió este teléfono en esta campaña, saltar.
      if (alreadySent(campaignId, to)) {
        results.duplicates += 1;
        metrics.inc("wa.duplicate");
        return;
      }

      const r = await postToMetaWithRetry(url, payload, token);
      if (r.ok) {
        results.sent += 1;
        metrics.inc("wa.sent");
        markSent(campaignId, to);
        // wamid: id del mensaje devuelto por Meta, clave para cruzar el
        // estado de entrega que llega después por webhook.
        const wamid = r.data?.messages?.[0]?.id || null;
        trackRows.push({
          campaignId,
          channel: "whatsapp",
          recipient: String(to),
          recipientName: msg?.name || null,
          providerMessageId: wamid,
          sendStatus: "accepted",
          sendError: null,
          providerRaw: r.data ? { contacts: r.data.contacts } : null,
        });
      } else {
        const err = r.err;
        const errMsg =
          err?.response?.data?.error?.message ||
          err?.response?.data ||
          err?.message ||
          "Error desconocido";
        results.ok = false;
        results.errors.push(
          `(${to}) ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}`,
        );
        metrics.inc("wa.failed");
        logger.error("wa.failed", {
          to,
          status: err?.response?.status,
          error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
        });
        trackRows.push({
          campaignId,
          channel: "whatsapp",
          recipient: String(to),
          recipientName: msg?.name || null,
          providerMessageId: null,
          sendStatus: "failed",
          sendError:
            typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
          deliveryStatus: "failed",
          deliveryReason:
            typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
        });
      }
    }),
  );

  await Promise.allSettled(jobs);

  // Persistencia de tracking (best-effort, no bloquea la respuesta si falla).
  try {
    await db.upsertCampaign(campaignId, campaignName);
    await db.insertMessages(trackRows);
  } catch (e) {
    logger.error("wa.persist.failed", { error: e?.message });
  }

  logger.info("wa.batch.done", {
    campaignId,
    sent: results.sent,
    duplicates: results.duplicates,
    errors: results.errors.length,
  });

  res.json(results);
});

// ===============================
// APPLY CAMPAIGN - EMAIL (relay a Amazon SES v2)
// ===============================
//
// Espera body:
// {
//   campaignId: "Verano2026-2026-06-07",
//   campaignName: "Verano 2026",          // opcional, se sustituye en {{destino}}
//   from: "no-reply@viajesyviajes.com",   // opcional, default SES_DEFAULT_FROM
//   subject: "Hola {{nombre}}, oferta {{destino}}",
//   html: "<p>Hola {{nombre}}, ...</p>",  // html y/o text (al menos uno)
//   text: "Hola {{nombre}}, ...",         // opcional
//   replyTo: "ventas@viajesyviajes.com",  // opcional
//   // Una de:
//   recipients: [{email:"a@b.com", name:"Ana Pérez"}, ...]  // PREFERIDO (permite personalizar)
//   // o (compat):
//   destinos: ["a@b.com", "c@d.com", ...]
// }
//
// Merge tags soportados en subject/html/text:
//   {{nombre}}    → primer nombre del recipient (extrae primera palabra de name)
//   {{destino}}   → campaignName (constante por campaña)
//
// Credenciales SES en env:
//   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_DEFAULT_FROM
//
// Concurrencia limitada a 10 paralelos (SES en producción permite ~14/s).
// Si un envío falla, los demás continúan; el error se reporta en errors[].
// Idempotencia por (campaignId|email) reutilizando el sentCache.

const emailLimit = pLimit(10);

// --- Helpers de merge tags ---
//
// Sustituye {{nombre}} y {{destino}} en el template. Si una variable no
// está disponible (e.g. el recipient no tiene name), se reemplaza por "".
// Importante: usa regex con flag `g` y escapa el nombre del placeholder.
function substituteMergeTags(template, vars) {
  if (typeof template !== "string" || !template.includes("{{")) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const v = vars?.[key];
    return v != null ? String(v) : "";
  });
}

// Detecta rápido si un campo trae merge tags — solo para logs.
function detectMergeTags(...texts) {
  return texts.some((t) => typeof t === "string" && /\{\{\s*\w+\s*\}\}/.test(t));
}

// Extrae el primer nombre. Si name="Julieta Pérez González" → "Julieta".
function firstName(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)[0] || "";
}

// Acepta:
//   recipients=[{email, name}]   ← formato nuevo (preferido)
//   destinos=["a@b.com", ...]    ← legacy (sin personalización)
// Devuelve siempre [{email, name}] limpio.
function normalizeRecipients(recipientsRaw, destinosRaw) {
  if (Array.isArray(recipientsRaw) && recipientsRaw.length) {
    return recipientsRaw
      .map((r) => {
        if (typeof r === "string") return { email: r.trim(), name: "" };
        if (r && typeof r === "object") {
          return {
            email: String(r.email || "").trim(),
            name: String(r.name || "").trim(),
          };
        }
        return null;
      })
      .filter((r) => r && r.email);
  }
  if (Array.isArray(destinosRaw)) {
    return destinosRaw
      .map((d) => ({ email: String(d || "").trim(), name: "" }))
      .filter((r) => r.email);
  }
  return [];
}

app.post("/apply-campaign/email", async (req, res) => {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return res.status(500).json({
      ok: false,
      error: "AWS credentials no configuradas en el servidor.",
    });
  }
  if (!process.env.SES_DEFAULT_FROM && !req.body?.from) {
    return res.status(500).json({
      ok: false,
      error: "SES_DEFAULT_FROM no configurado y no llegó 'from' en el body.",
    });
  }

  const {
    campaignId,
    campaignName,
    from,
    subject,
    html,
    text,
    replyTo,
    destinos,
    recipients: recipientsRaw,
  } = req.body || {};

  if (!campaignId || typeof campaignId !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "Falta campaignId (string) en el body." });
  }
  if (!subject || typeof subject !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "Falta subject (string) en el body." });
  }
  if (!html && !text) {
    return res
      .status(400)
      .json({ ok: false, error: "Debes incluir 'html' y/o 'text'." });
  }

  // Normalizar recipients: aceptamos el formato nuevo [{email, name}] y el
  // legacy ["email"]. Internamente trabajamos siempre con {email, name}.
  const recipients = normalizeRecipients(recipientsRaw, destinos);
  if (recipients.length === 0) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "Debes mandar 'recipients' o 'destinos' con al menos un destino.",
      });
  }

  logger.info("email.batch.start", {
    campaignId,
    batchSize: recipients.length,
    hasMergeTags: detectMergeTags(subject, html, text),
  });

  const results = {
    ok: true,
    sent: 0,
    duplicates: 0,
    rejected: 0,
    errors: [],
    messageIds: [],
  };
  const trackRows = []; // filas para persistir (best-effort)

  const jobs = recipients.map((rcp) =>
    emailLimit(async () => {
      const dest = rcp.email;
      if (!dest) {
        results.errors.push("(vacio) destino vacío");
        results.rejected += 1;
        return;
      }
      // Idempotencia: misma campaña + mismo correo no se reenvía.
      if (alreadySent(campaignId, dest)) {
        results.duplicates += 1;
        metrics.inc("email.duplicate");
        return;
      }

      // Variables disponibles para este destinatario.
      const vars = {
        nombre: firstName(rcp.name),
        destino: String(campaignName || "").trim(),
      };
      const personalSubject = substituteMergeTags(subject, vars);
      const personalHtml = html ? substituteMergeTags(html, vars) : html;
      const personalText = text ? substituteMergeTags(text, vars) : text;

      const r = await sendOneEmail({
        from,
        to: dest,
        subject: personalSubject,
        html: personalHtml,
        text: personalText,
        replyTo,
      });
      if (r.ok) {
        results.sent += 1;
        results.messageIds.push(r.messageId);
        metrics.inc("email.sent");
        markSent(campaignId, dest);
        // MessageId de SES: clave para cruzar bounces/complaints/deliveries
        // que llegan después por SNS.
        trackRows.push({
          campaignId,
          channel: "email",
          recipient: dest,
          recipientName: rcp.name || null,
          providerMessageId: r.messageId || null,
          sendStatus: "accepted",
          sendError: null,
        });
      } else {
        results.ok = false;
        results.rejected += 1;
        results.errors.push(`(${dest}) ${r.error || r.code || "Error SES"}`);
        metrics.inc("email.failed");
        logger.error("email.failed", { to: dest, code: r.code, error: r.error });
        trackRows.push({
          campaignId,
          channel: "email",
          recipient: dest,
          recipientName: rcp.name || null,
          providerMessageId: null,
          sendStatus: "failed",
          sendError: r.error || r.code || "Error SES",
          deliveryStatus: "failed",
          deliveryReason: r.error || r.code || "Error SES",
        });
      }
    }),
  );

  await Promise.allSettled(jobs);

  // Persistencia de tracking (best-effort, no bloquea la respuesta si falla).
  try {
    await db.upsertCampaign(campaignId, campaignName);
    await db.insertMessages(trackRows);
  } catch (e) {
    logger.error("email.persist.failed", { error: e?.message });
  }

  logger.info("email.batch.done", {
    campaignId,
    sent: results.sent,
    duplicates: results.duplicates,
    rejected: results.rejected,
    errors: results.errors.length,
  });

  res.json(results);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info("server.started", {
    port: Number(PORT),
    nodeEnv: process.env.NODE_ENV || null,
    dbEnabled: db.isEnabled(),
  });
  // Crea las tablas de tracking si hay DATABASE_URL. No bloquea el arranque.
  db.init().catch((err) =>
    logger.error("db.init.unhandled", { error: err?.message }),
  );
});
