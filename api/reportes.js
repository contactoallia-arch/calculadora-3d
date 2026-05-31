import { getDB } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const tipo = req.query.tipo;

  if (tipo === "cobros-pendientes") {
    const r = await db.execute(`
      SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.precio, p.moneda, p.fecha, p.fecha_entrega,
        COALESCE(SUM(c.monto),0) as cobrado,
        p.precio - COALESCE(SUM(c.monto),0) as pendiente
      FROM presupuestos p
      LEFT JOIN cobros c ON c.presupuesto_id=p.id
      WHERE p.estado='entregado'
      GROUP BY p.id
      HAVING pendiente > 0
      ORDER BY p.fecha ASC
    `);
    const total = r.rows.reduce((s, x) => s + Number(x.pendiente), 0);
    return res.status(200).json({ ok: true, data: { items: r.rows, total } });
  }

  if (tipo === "rentabilidad") {
    const { desde, hasta } = req.query || {};
    let condFecha = "1=1";
    const args1 = [], args2 = [];
    if (desde && hasta) {
      condFecha = "(fecha >= ? AND fecha <= ?)";
      args1.push(desde, hasta);
      args2.push(desde, hasta);
    }
    const [ingrR, gastR, presR] = await Promise.all([
      db.execute({ sql: `SELECT moneda, COALESCE(SUM(monto),0) as total FROM cobros WHERE ${condFecha} GROUP BY moneda`, args: args1 }),
      db.execute({ sql: `SELECT categoria, COALESCE(SUM(monto),0) as total FROM gastos WHERE ${condFecha} GROUP BY categoria ORDER BY total DESC`, args: args2 }),
      db.execute({ sql: `SELECT estado, COUNT(*) as cnt, COALESCE(SUM(precio),0) as total FROM presupuestos WHERE ${condFecha} GROUP BY estado`, args: args1 })
    ]);
    return res.status(200).json({ ok: true, data: { ingresos: ingrR.rows, gastosPorCategoria: gastR.rows, presupuestosPorEstado: presR.rows } });
  }

  return res.status(400).json({ ok: false, error: "Tipo de reporte no reconocido" });
}
