require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const pLimit = require("p-limit").default;

const app = express();

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
    console.warn("[CORS] Origin no permitido:", origin);
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
  console.warn("[Auth] Petición rechazada en", req.path, "ip", req.ip);
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
      await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      });
      return { ok: true };
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

app.get("/", (req, res) => {
  res.send("Backend funcionando");
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
      PORT: process.env.PORT || null,
      NODE_ENV: process.env.NODE_ENV || null,
    },
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
    const r = await axios.get(url, {
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
    console.error("[whatsapp/templates] error:", msg);
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

  const { mensaje, destinos, sendAt } = req.body || {};
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

  const { campaignId, messages } = req.body || {};
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


  const results = { ok: true, sent: 0, duplicates: 0, errors: [] };

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
        return;
      }

      const r = await postToMetaWithRetry(url, payload, token);
      if (r.ok) {
        results.sent += 1;
        markSent(campaignId, to);
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
        console.error("ERROR:", to, errMsg);
      }
    }),
  );

  await Promise.allSettled(jobs);


  res.json(results);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
});
