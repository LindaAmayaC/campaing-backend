// Contadores en memoria mínimos. Para producción real usar Prometheus o
// equivalente; aquí dejamos GET /metrics como introspección rápida.

const counters = Object.create(null);

function inc(name, by = 1) {
  counters[name] = (counters[name] || 0) + by;
}

function snapshot() {
  return { ...counters };
}

module.exports = { inc, snapshot };
