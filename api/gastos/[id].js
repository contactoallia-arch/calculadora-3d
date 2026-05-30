import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin", "operador"]);
  if (!user) return;

  const id = req.query.id;

  if (req.method === "PUT") {
    const { categoria, descripcion, para_que, monto, moneda, fecha, tipo_cambio, medio_pago } = req.body || {};
    await db.execute({
      sql: "UPDATE gastos SET categoria=?,descripcion=?,para_que=?,monto=?,moneda=?,tipo_cambio=?,fecha=?,medio_pago=? WHERE id=?",
      args: [categoria||"otros", descripcion, para_que||null, monto, moneda||"UYU", tipo_cambio||null, fecha, medio_pago||"efectivo", id]
    });
    await logAction(db, user, "EDITAR_GASTO", "gasto", id);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    await db.execute({ sql: "DELETE FROM gastos WHERE id=?", args: [id] });
    await logAction(db, user, "ELIMINAR_GASTO", "gasto", id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
