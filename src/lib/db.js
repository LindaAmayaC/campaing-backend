/*
 * src/lib/db.js
 * Capa de persistencia (Postgres) para el tracking de entregas.
 *
 * Filosofía:
 *   - Si NO hay DATABASE_URL en el entorno, el módulo queda DESACTIVADO:
 *     todas las funciones son no-ops seguras. El backend sigue enviando
 *     mensajes con normalidad (la persistencia es un añadido, no un
 *     requisito para enviar).
 *   - Todas las escrituras son "best-effort": si la DB falla, se loguea el
 *     error pero NUNCA se propaga para no tumbar una campaña en curso.
 *
 * Tablas:
 *   campaigns(id, name, created_at)
 *   messages(id, campaign_id, channel, recipient, recipient_name,
 *            provider_message_id, send_status, send_error,
 *            delivery_status, delivery_reason, provider_raw,
 *            sent_at, delivered_at, updated_at)
 *
 * El cruce con las respuestas asíncronas de los proveedores (webhooks SES /
 * Meta y polling de Infobip) se hace por (channel, provider_message_id).
 */
"use strict";

const logger = require("./logger");

const DATABASE_URL = process.env.DATABASE_URL || "";
const enabled = Boolean(DATABASE_URL);

let pool = null;

if (enabled) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway Postgres requiere SSL. rejectUnauthorized:false porque usa
    // certificado interno; ajustar si se mueve a un cert verificado.
    ssl: /railway|proxy\.rlwy|sslmode=require/i.test(DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => {
    logger.error("db.pool.error", { error: err?.message });
  });
}

function isEnabled() {
  return enabled;
}

/**
 * Crea las tablas si no existen. Se llama una vez al arrancar el server.
 * Si la DB no está configurada, no hace nada.
 */
async function init() {
  if (!enabled) {
    logger.warn("db.disabled", {
      msg: "DATABASE_URL no configurada; tracking de entregas desactivado.",
    });
    return;
  }
  const ddl = `
    CREATE TABLE IF NOT EXISTS campaigns (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  BIGSERIAL PRIMARY KEY,
      campaign_id         TEXT NOT NULL,
      channel             TEXT NOT NULL,           -- 'email' | 'whatsapp' | 'sms'
      recipient           TEXT NOT NULL,           -- email o teléfono (E.164)
      recipient_name      TEXT,
      provider_message_id TEXT,                    -- SES MessageId / wamid / Infobip messageId
      send_status         TEXT NOT NULL,           -- 'accepted' | 'failed'
      send_error          TEXT,
      delivery_status     TEXT NOT NULL DEFAULT 'pending',
      delivery_reason     TEXT,
      provider_raw        JSONB,
      sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at        TIMESTAMPTZ,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_provider
      ON messages (channel, provider_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_campaign
      ON messages (campaign_id);
    CREATE INDEX IF NOT EXISTS idx_messages_delivery
      ON messages (channel, delivery_status);
  `;
  try {
    await pool.query(ddl);
    logger.info("db.init.ok");
  } catch (err) {
    logger.error("db.init.failed", { error: err?.message });
  }
}

/**
 * Registra (o actualiza el nombre de) una campaña. Idempotente por id.
 */
async function upsertCampaign(id, name) {
  if (!enabled || !id) return;
  try {
    await pool.query(
      `INSERT INTO campaigns (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, campaigns.name)`,
      [String(id), name != null ? String(name) : null],
    );
  } catch (err) {
    logger.error("db.upsertCampaign.failed", { id, error: err?.message });
  }
}

/**
 * Inserta un lote de mensajes. Cada item:
 *   {
 *     campaignId, channel, recipient, recipientName,
 *     providerMessageId, sendStatus, sendError,
 *     deliveryStatus?, deliveryReason?, providerRaw?
 *   }
 * Best-effort: si falla, loguea y sigue. Devuelve cuántos insertó.
 */
async function insertMessages(items) {
  if (!enabled || !Array.isArray(items) || items.length === 0) return 0;

  // Construimos un multi-row INSERT parametrizado en chunks para no pasar
  // el límite de parámetros de Postgres (~65535). 10 columnas por fila →
  // chunk de 1000 filas es holgado.
  const COLS = 10;
  const CHUNK = 1000;
  let inserted = 0;

  for (let start = 0; start < items.length; start += CHUNK) {
    const slice = items.slice(start, start + CHUNK);
    const values = [];
    const placeholders = slice.map((it, i) => {
      const b = i * COLS;
      values.push(
        String(it.campaignId || ""),
        String(it.channel || ""),
        String(it.recipient || ""),
        it.recipientName != null ? String(it.recipientName) : null,
        it.providerMessageId != null ? String(it.providerMessageId) : null,
        String(it.sendStatus || "accepted"),
        it.sendError != null ? String(it.sendError) : null,
        String(it.deliveryStatus || "pending"),
        it.deliveryReason != null ? String(it.deliveryReason) : null,
        it.providerRaw != null ? JSON.stringify(it.providerRaw) : null,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
    });

    const sql = `
      INSERT INTO messages
        (campaign_id, channel, recipient, recipient_name,
         provider_message_id, send_status, send_error,
         delivery_status, delivery_reason, provider_raw)
      VALUES ${placeholders.join(",")}
    `;
    try {
      const r = await pool.query(sql, values);
      inserted += r.rowCount || 0;
    } catch (err) {
      logger.error("db.insertMessages.failed", {
        chunkSize: slice.length,
        error: err?.message,
      });
    }
  }
  return inserted;
}

/**
 * Actualiza el estado de entrega de un mensaje identificado por su
 * provider_message_id (usado por los webhooks y el poller en el paso 2).
 * `terminal` marca delivered_at cuando el estado es final.
 */
async function updateDeliveryByProviderId(channel, providerMessageId, patch) {
  if (!enabled || !providerMessageId) return 0;
  const {
    deliveryStatus,
    deliveryReason,
    setDeliveredAt = false,
    providerRaw,
  } = patch || {};
  try {
    const r = await pool.query(
      `UPDATE messages
         SET delivery_status = COALESCE($3, delivery_status),
             delivery_reason = COALESCE($4, delivery_reason),
             delivered_at    = CASE WHEN $5 THEN now() ELSE delivered_at END,
             provider_raw    = COALESCE($6, provider_raw),
             updated_at      = now()
       WHERE channel = $1 AND provider_message_id = $2`,
      [
        String(channel),
        String(providerMessageId),
        deliveryStatus != null ? String(deliveryStatus) : null,
        deliveryReason != null ? String(deliveryReason) : null,
        Boolean(setDeliveredAt),
        providerRaw != null ? JSON.stringify(providerRaw) : null,
      ],
    );
    return r.rowCount || 0;
  } catch (err) {
    logger.error("db.updateDelivery.failed", {
      channel,
      providerMessageId,
      error: err?.message,
    });
    return 0;
  }
}

/**
 * Query directa (para el endpoint de reportes en el paso 3). Devuelve rows
 * o [] si la DB está desactivada.
 */
async function query(sql, params) {
  if (!enabled) return { rows: [] };
  return pool.query(sql, params);
}

module.exports = {
  isEnabled,
  init,
  upsertCampaign,
  insertMessages,
  updateDeliveryByProviderId,
  query,
  _pool: () => pool,
};
