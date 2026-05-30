import { getDB } from "./_lib/db.js";
import { requireAuth, logAction } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const id = req.query.id;

  if (id) {
    const user2 = await requireAuth(req, res, db, ["admin", "operador"]);
    if (!user2) return;
    if (req.method === "DELETE") {
      await db.execute({ sql: "DELETE FROM cobros WHERE id=?", args: [id] });
      await logAction(db, user2, "ELIMINAR_COBRO", "cobro", id);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "PUT") {
      const { monto, moneda, medio_pago, fecha, nota } = req.body || {};
      await db.execute({ sql: "UPDATE cobros SET monto=?,moneda=?,medio_pago=?,fecha=?,nota=? WHERE id=?", args: [monto, moneda||"UYU", medio_pago||"efectivo", fecha, nota||null, id] });
      await logAction(db, user2, "EDITAR_COBRO", "cobro", id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  if (req.method === "GET") {
    const { mes, cliente_id, presupuesto_id } = req.query || {};
    let sql = `SELECT co.*, p.pieza, p.numero as pres_numero, c.nombre as cliente_nombre
               FROM cobros co
               LEFT JOIN presupuestos p ON p.id=co.presupuesto_id
               LEFT JOIN clientes c ON c.id=co.cliente_id
               WHERE 1=1`;
    const args = [];
    if (mes) { sql += " AND co.fecha LIKE ?"; args.push(`%${mes}%`); }
    if (cliente_id) { sql += " AND co.cliente_id=?"; args.push(cliente_id); }
    if (presupuesto_id) { sql += " AND co.presupuesto_id=?"; args.push(presupuesto_id); }
    sql += " ORDER BY co.fecha DESC, co.id DESC LIMIT 500";
    const r = await db.execute({ sql, args });
    return res.status(200).json({ ok: true, data: r.rows });
  }

  if (req.method === "POST") {
    const { presupuesto_id, cliente_id, monto, moneda, tipo_cambio, medio_pago, fecha, nota } = req.body || {};
    if (!presupuesto_id || !monto) return res.status(400).json({ ok: false, error: "presupuesto_id y monto requeridos" });
    const r = await db.execute({
      sql: "INSERT INTO cobros (presupuesto_id,cliente_id,monto,moneda,tipo_cambio,medio_pago,fecha,nota,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [presupuesto_id, cliente_id||null, monto, moneda||"UYU", tipo_cambio||null, medio_pago||"efectivo",
             fecha||new Date().toLocaleDateString("es-UY"), nota||null, user.id]
    });
    const newId = Number(r.lastInsertRowid);
    try {
      const pr = await db.execute({ sql: "SELECT precio,estado FROM presupuestos WHERE id=?", args: [presupuesto_id] });
      const pres = pr.rows[0];
      if (pres && pres.estado === "entregado") {
        const cobrRes = await db.execute({ sql: "SELECT SUM(monto) as total FROM cobros WHERE presupuesto_id=?", args: [presupuesto_id] });
        const totalCobrado = Number(cobrRes.rows[0]?.total || 0);
        if (totalCobrado >= pres.precio) {
          await db.execute({ sql: "UPDATE presupuestos SET estado='cobrado',updated_at=datetime('now') WHERE id=?", args: [presupuesto_id] });
          await db.execute({ sql: "INSERT INTO presupuesto_estados (presupuesto_id,estado_anterior,estado_nuevo,nota,usuario_id,usuario_nombre) VALUES (?,?,?,?,?,?)", args: [presupuesto_id, "entregado", "cobrado", "Cobro automático completo", user.id, user.nombre] });
        }
      }
    } catch {}
    await logAction(db, user, "REGISTRAR_COBRO", "cobro", newId);
    return res.status(200).json({ ok: true, data: { id: newId } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
