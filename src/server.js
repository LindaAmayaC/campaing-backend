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

const limit = pLimit(3);

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
      PORT: process.env.PORT || null,
      NODE_ENV: process.env.NODE_ENV || null,
    },
  });
});

// ===============================
// APPLY CAMPAIGN - WHATSAPP (relay)
// ===============================
//
// Espera body:
// {
//   phoneNumberId: "990605564142727",
//   messages: [
//     { to: "57XXXXXXXXXX", payload: { messaging_product, to, type, template, ... } },
//     ...
//   ]
// }
//
// El frontend arma cada `payload` listo para Meta (igual que hoy hace
// sendWhatsappMessages en ViajesYV). Este endpoint solo reenvía.
// El token sale de process.env.WHATSAPP_TOKEN.

app.post("/apply-campaign/whatsapp", async (req, res) => {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    return res
      .status(500)
      .json({ ok: false, error: "WHATSAPP_TOKEN no configurado en el servidor." });
  }

  const { phoneNumberId, messages } = req.body || {};

  if (!phoneNumberId) {
    return res
      .status(400)
      .json({ ok: false, error: "Falta phoneNumberId en el body." });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: "messages debe ser un array no vacío." });
  }

  const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`;

  console.log(`[apply-campaign/whatsapp] enviando ${messages.length} mensajes`);

  const results = { ok: true, sent: 0, errors: [] };

  const jobs = messages.map((msg) =>
    limit(async () => {
      const to = msg?.to || msg?.payload?.to || "desconocido";
      const payload = msg?.payload;
      if (!payload) {
        results.ok = false;
        results.errors.push(`(${to}) payload vacío`);
        return;
      }

      try {
        await axios.post(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        results.sent += 1;
        console.log("OK:", to);
      } catch (err) {
        const errMsg =
          err?.response?.data?.error?.message ||
          err?.response?.data ||
          err.message ||
          "Error desconocido";
        results.ok = false;
        results.errors.push(`(${to}) ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}`);
        console.error("ERROR:", to, errMsg);
      }
    }),
  );

  await Promise.allSettled(jobs);

  console.log(
    `[apply-campaign/whatsapp] finalizado: ${results.sent} ok, ${results.errors.length} errores`,
  );

  res.json(results);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});
