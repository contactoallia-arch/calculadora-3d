import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const id = req.query.id;

  // GET — detalle de un presupuesto
  if (req.method === "GET") {
    const r = await db.execute({
      sql: `SELECT p.*, COALESCE(p.numero,p.id) as numero_display, c.nombre as cliente_nombre
            FROM presupuestos p LEFT JOIN clientes c ON c.id=p.cliente_id WHERE p.id=?`,
      args: [id]
    });
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
    const pres = { ...r.rows[0], snap: r.rows[0].snap ? JSON.parse(r.rows[0].snap) : null };
    const cobros = await db.execute({ sql: "SELECT * FROM cobros WHERE presupuesto_id=? ORDER BY fecha DESC", args: [id] });
    const estados = await db.execute({ sql: "SELECT * FROM presupuesto_estados WHERE presupuesto_id=? ORDER BY id DESC", args: [id] });
    return res.status(200).json({ ok: true, data: { ...pres, cobros: cobros.rows, estados: estados.rows } });
  }

  // PUT — editar campos
  if (req.method === "PUT") {
    const { numero, pieza, cliente, cliente_id, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas } = req.body || {};
    await db.execute({
      sql: `UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=?,
            moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,updated_at=datetime('now') WHERE id=?`,
      args: [numero, pieza||"Sin nombre", cliente||"—", cliente_id||null, mat||"", qty||1, precio, margen||0,
             fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null,
             moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, id]
    });
    return res.status(200).json({ ok: true });
  }

  // DELETE — borrar
  if (req.method === "DELETE") {
    await db.execute({ sql: "DELETE FROM presupuestos WHERE id=?", args: [id] });
    await db.execute({ sql: "DELETE FROM presupuesto_estados WHERE presupuesto_id=?", args: [id] });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
