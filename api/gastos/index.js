import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  if (req.method === "GET") {
    const { mes, categoria, tipo } = req.query || {};
    let sql = "SELECT * FROM gastos WHERE 1=1";
    const args = [];
    if (mes) { sql += " AND fecha LIKE ?"; args.push(`%${mes}%`); }
    if (categoria) { sql += " AND categoria=?"; args.push(categoria); }
    if (tipo) { sql += " AND tipo=?"; args.push(tipo); }
    sql += " ORDER BY fecha DESC, id DESC LIMIT 500";
    const r = await db.execute({ sql, args });
    return res.status(200).json({ ok: true, data: r.rows });
  }

  if (req.method === "POST") {
    const { categoria, descripcion, monto, moneda, tipo_cambio, fecha, tipo, presupuesto_id, recurrente, gasto_fijo_id } = req.body || {};
    if (!descripcion || !monto) return res.status(400).json({ ok: false, error: "Descripción y monto requeridos" });
    const r = await db.execute({
      sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,tipo_cambio,fecha,tipo,presupuesto_id,recurrente,gasto_fijo_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      args: [categoria||"otros", descripcion, monto, moneda||"UYU", tipo_cambio||null,
             fecha||new Date().toLocaleDateString("es-UY"), tipo||"manual",
             presupuesto_id||null, recurrente?1:0, gasto_fijo_id||null, user.id]
    });
    const id = Number(r.lastInsertRowid);
    await logAction(db, user, "CREAR_GASTO", "gasto", id);
    return res.status(200).json({ ok: true, data: { id } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
