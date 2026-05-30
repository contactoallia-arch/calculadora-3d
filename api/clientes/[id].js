import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const id = req.query.id;

  if (req.method === "GET") {
    const r = await db.execute({ sql: "SELECT * FROM clientes WHERE id=?", args: [id] });
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
    const presups = await db.execute({
      sql: "SELECT id,numero,pieza,estado,precio,moneda,fecha FROM presupuestos WHERE cliente_id=? ORDER BY id DESC",
      args: [id]
    });
    return res.status(200).json({ ok: true, data: { ...r.rows[0], presupuestos: presups.rows } });
  }

  if (req.method === "PUT") {
    const { nombre, email, telefono, notas, activo } = req.body || {};
    await db.execute({
      sql: "UPDATE clientes SET nombre=?,email=?,telefono=?,notas=?,activo=? WHERE id=?",
      args: [nombre, email || null, telefono || null, notas || null, activo !== undefined ? activo : 1, id]
    });
    await logAction(db, user, "EDITAR_CLIENTE", "cliente", id);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    if (user.rol !== "admin") return res.status(403).json({ ok: false, error: "Sin permiso" });
    await db.execute({ sql: "UPDATE clientes SET activo=0 WHERE id=?", args: [id] });
    await logAction(db, user, "ELIMINAR_CLIENTE", "cliente", id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
