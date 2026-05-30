import { getDB } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin", "operador"]);
  if (!user) return;

  const id = req.query.id;

  if (req.method === "PUT") {
    const { nombre, categoria, monto, moneda, dia_del_mes, activo } = req.body || {};
    await db.execute({
      sql: "UPDATE gastos_fijos SET nombre=?,categoria=?,monto=?,moneda=?,dia_del_mes=?,activo=? WHERE id=?",
      args: [nombre, categoria||"otros", monto, moneda||"UYU", dia_del_mes||1, activo?1:0, id]
    });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    await db.execute({ sql: "DELETE FROM gastos_fijos WHERE id=?", args: [id] });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
