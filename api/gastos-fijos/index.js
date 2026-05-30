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
    const r = await db.execute("SELECT * FROM gastos_fijos ORDER BY dia_del_mes,nombre");
    return res.status(200).json({ ok: true, data: r.rows });
  }

  if (req.method === "POST") {
    const { nombre, categoria, monto, moneda, dia_del_mes } = req.body || {};
    if (!nombre || !monto) return res.status(400).json({ ok: false, error: "Nombre y monto requeridos" });
    const r = await db.execute({
      sql: "INSERT INTO gastos_fijos (nombre,categoria,monto,moneda,dia_del_mes) VALUES (?,?,?,?,?)",
      args: [nombre, categoria||"otros", monto, moneda||"UYU", dia_del_mes||1]
    });
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
