// Logger estructurado JSON. Cada línea es un objeto parseable, ideal para
// Railway/LogTail/Datadog. Mantiene console.error/warn como fallback.
//
// Uso:
//   logger.info("apply-campaign/whatsapp", { campaignId, batch: 1, sent: 1000 });
//   logger.warn("auth.rejected", { ip });
//   logger.error("meta.failed", { to, error });

const LEVELS = ["debug", "info", "warn", "error"];
const MIN_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();
const minIdx = Math.max(0, LEVELS.indexOf(MIN_LEVEL));

function emit(level, msg, ctx) {
  if (LEVELS.indexOf(level) < minIdx) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: String(msg || ""),
    ...(ctx && typeof ctx === "object" ? ctx : {}),
  };
  // stderr para warn/error para no contaminar stdout en pipes.
  const out = level === "warn" || level === "error" ? process.stderr : process.stdout;
  try {
    out.write(JSON.stringify(record) + "\n");
  } catch (_) {
    // fallback bruto si el record tiene refs circulares
    out.write(`${level} ${msg}\n`);
  }
}

module.exports = {
  debug: (msg, ctx) => emit("debug", msg, ctx),
  info: (msg, ctx) => emit("info", msg, ctx),
  warn: (msg, ctx) => emit("warn", msg, ctx),
  error: (msg, ctx) => emit("error", msg, ctx),
};
