import { getDB } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const r = await db.execute(`
    SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.precio, p.moneda, p.fecha,
      COALESCE(SUM(c.monto),0) as cobrado,
      p.precio - COALESCE(SUM(c.monto),0) as pendiente
    FROM presupuestos p
    LEFT JOIN cobros c ON c.presupuesto_id=p.id
    WHERE p.estado='entregado'
    GROUP BY p.id
    HAVING pendiente > 0
    ORDER BY p.fecha ASC
  `);

  const total = r.rows.reduce((s,x) => s + Number(x.pendiente), 0);
  return res.status(200).json({ ok: true, data: { items: r.rows, total } });
}
