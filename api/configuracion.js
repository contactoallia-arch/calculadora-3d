import { getDB } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  // Proxy cotización USD/UYU — intenta BCU, fallback open.er-api
  if (req.query.action === "tipo-cambio") {
    // 1) BCU (Banco Central del Uruguay)
    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2,"0");
      const mm = String(today.getMonth()+1).padStart(2,"0");
      const yyyy = today.getFullYear();
      const fecha = `${dd}%2F${mm}%2F${yyyy}`;
      const r = await fetch(
        `https://cotizaciones.bcu.gub.uy/wscotizaciones/rest/?Fecha=${fecha}&Moneda=2225&Grupo=0`,
        { headers: { Accept: "application/json" } }
      );
      if (r.ok) {
        const d = await r.json();
        // BCU devuelve array o { value: [...] }
        const rows = Array.isArray(d) ? d : (d.value || d.Cotizaciones || []);
        const row = rows[0];
        if (row) {
          // Tomar precio de venta (Venta) como referencia
          const rate = parseFloat(row.Venta || row.venta || row.tipoCambio || 0);
          if (rate > 0) {
            const fechaBCU = row.Fecha || row.fecha || `${dd}/${mm}/${yyyy}`;
            return res.status(200).json({ ok: true, rate, date: fechaBCU, fuente: "BCU" });
          }
        }
      }
    } catch {}

    // 2) Fallback: open.er-api.com (también usado en la calculadora)
    try {
      const r2 = await fetch("https://open.er-api.com/v6/latest/USD");
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
      const d2 = await r2.json();
      const rate = d2.rates?.UYU;
      if (!rate) throw new Error("Sin datos");
      const date = d2.time_last_update_utc
        ? new Date(d2.time_last_update_utc).toISOString().slice(0,10)
        : new Date().toISOString().slice(0,10);
      return res.status(200).json({ ok: true, rate, date, fuente: "open.er-api" });
    } catch (e2) {
      return res.status(200).json({ ok: false, error: "No se pudo obtener cotización: " + e2.message });
    }
  }

  if (req.method === "GET") {
    const r = await db.execute("SELECT clave, valor FROM configuracion");
    const cfg = {};
    r.rows.forEach(row => { cfg[row.clave] = row.valor; });
    return res.status(200).json({ ok: true, data: cfg });
  }

  if (req.method === "PUT") {
    if (user.rol !== "admin") return res.status(403).json({ ok: false, error: "Sin permiso" });
    const updates = req.body || {};
    for (const [k, v] of Object.entries(updates)) {
      await db.execute({ sql: "INSERT OR REPLACE INTO configuracion (clave,valor) VALUES (?,?)", args: [k, String(v)] });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
