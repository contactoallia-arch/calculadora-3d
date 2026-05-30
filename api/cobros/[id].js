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

  if (req.method === "DELETE") {
    await db.execute({ sql: "DELETE FROM cobros WHERE id=?", args: [id] });
    await logAction(db, user, "ELIMINAR_COBRO", "cobro", id);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PUT") {
    const { monto, moneda, medio_pago, fecha, nota } = req.body || {};
    await db.execute({
      sql: "UPDATE cobros SET monto=?,moneda=?,medio_pago=?,fecha=?,nota=? WHERE id=?",
      args: [monto, moneda||"UYU", medio_pago||"efectivo", fecha, nota||null, id]
    });
    await logAction(db, user, "EDITAR_COBRO", "cobro", id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
