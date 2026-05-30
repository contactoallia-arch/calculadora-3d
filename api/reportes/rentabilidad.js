import { getDB } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

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

  return res.status(200).json({
    ok: true,
    data: {
      ingresos: ingrR.rows,
      gastosPorCategoria: gastR.rows,
      presupuestosPorEstado: presR.rows
    }
  });
}
