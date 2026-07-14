/*
 * src/lib/smsPoller.js
 * Poller de delivery reports de Infobip (Onmall) para SMS.
 *
 * Infobip NO empuja el estado de entrega si no configurás un webhook DLR,
 * pero SÍ expone un endpoint de reportes que podemos CONSULTAR con las
 * mismas credenciales de envío (ONMALL_AUTH):
 *
 *   GET https://api.messaging-service.com/sms/1/reports?limit=1000
 *
 * Cada reporte se entrega UNA sola vez (se "consume" al leerlo), así que el
 * patrón correcto es: leer periódicamente y persistir de inmediato cruzando
 * por messageId.
 *
 * Respuesta (resumida):
 *   { results: [ { messageId, to, doneAt,
 *                  status: { groupName, name, description },
 *                  error:  { groupId, name, description, permanent } } ] }
 *
 * Mapeo de grupos:
 *   DELIVERED                      -> delivered
 *   UNDELIVERABLE|REJECTED|EXPIRED -> failed  (motivo = error.name/description)
 *   PENDING                        -> se deja en pending
 */
"use strict";

const axios = require("axios");
const logger = require("./logger");
const db = require("./db");

const INFOBIP_BASE = "https://api.messaging-service.com";
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 min

function authHeader() {
  const a = process.env.ONMALL_AUTH || "";
  if (!a) return "";
  return a.startsWith("Basic ") ? a : `Basic ${a}`;
}

function mapStatus(report) {
  const group = String(report?.status?.groupName || "").toUpperCase();
  if (group === "DELIVERED") {
    return { deliveryStatus: "delivered", reason: null, terminal: true };
  }
  if (group === "UNDELIVERABLE" || group === "REJECTED" || group === "EXPIRED") {
    const reason =
      report?.error?.name ||
      report?.error?.description ||
      report?.status?.name ||
      report?.status?.description ||
      group;
    return { deliveryStatus: "failed", reason, terminal: true };
  }
  // PENDING u otros → aún no es final.
  return { deliveryStatus: null, reason: null, terminal: false };
}

/**
 * Una pasada: pide reportes y actualiza la DB. Devuelve cuántos aplicó.
 */
async function pollOnce({ limit = 1000 } = {}) {
  const auth = authHeader();
  if (!auth) return 0;
  if (!db.isEnabled()) return 0;

  let results;
  try {
    const r = await axios.get(`${INFOBIP_BASE}/sms/1/reports`, {
      headers: { accept: "application/json", authorization: auth },
      params: { limit },
      timeout: 20000,
    });
    results = Array.isArray(r.data?.results) ? r.data.results : [];
  } catch (err) {
    const status = err?.response?.status;
    // 204/sin reportes no es error; Infobip a veces responde vacío.
    if (status && status !== 204) {
      logger.error("smsPoller.fetch.failed", {
        status,
        error: err?.response?.data?.requestError?.serviceException?.text || err?.message,
      });
    }
    return 0;
  }

  let applied = 0;
  for (const report of results) {
    const messageId = report?.messageId;
    if (!messageId) continue;
    const { deliveryStatus, reason, terminal } = mapStatus(report);
    if (!deliveryStatus) continue; // aún pending, nada que actualizar

    const n = await db.updateDeliveryByProviderId("sms", messageId, {
      deliveryStatus,
      deliveryReason: reason,
      setDeliveredAt: terminal,
      providerRaw: { status: report.status, error: report.error },
    });
    applied += n;
  }

  if (applied > 0) {
    logger.info("smsPoller.applied", { reports: results.length, applied });
  }
  return applied;
}

/**
 * Arranca el poller en intervalo. No-op si faltan credenciales o DB.
 * Devuelve el handle del setInterval (con unref, no bloquea el cierre).
 */
function startSmsPoller({ intervalMs } = {}) {
  const ms = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  if (!authHeader()) {
    logger.warn("smsPoller.disabled", { reason: "ONMALL_AUTH ausente" });
    return null;
  }
  if (!db.isEnabled()) {
    logger.warn("smsPoller.disabled", { reason: "DB desactivada" });
    return null;
  }
  logger.info("smsPoller.started", { intervalMs: ms });
  const handle = setInterval(() => {
    pollOnce().catch((err) =>
      logger.error("smsPoller.tick.failed", { error: err?.message }),
    );
  }, ms);
  handle.unref();
  return handle;
}

module.exports = { startSmsPoller, pollOnce, mapStatus };
