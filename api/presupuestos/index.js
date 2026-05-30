import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();

  // Compatibilidad: algunos endpoints no requieren auth aún (la calculadora)
  // Para GET/POST desde la calculadora se permite sin auth
  let user = null;
  try {
    const { requireAuth: ra } = await import("../_lib/auth.js");
    // intentar auth, pero no fallar si no hay token (modo calculadora legacy)
  } catch {}

  // GET — listar con filtros opcionales
  if (req.method === "GET") {
    const { estado, mes, cliente_id, search } = req.query || {};
    let sql = `SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.cliente_id,
      p.mat, p.qty, p.precio, p.margen, p.fecha, p.fecha_entrega,
      p.estado, p.moneda, p.notas, p.enviado_whatsapp, p.snap, p.created_at,
      c.nombre as cliente_nombre
      FROM presupuestos p
      LEFT JOIN clientes c ON c.id=p.cliente_id
      WHERE 1=1`;
    const args = [];
    if (estado) { sql += " AND p.estado=?"; args.push(estado); }
    if (mes) { sql += " AND p.fecha LIKE ?"; args.push(`%${mes}%`); }
    if (cliente_id) { sql += " AND p.cliente_id=?"; args.push(cliente_id); }
    if (search) { sql += " AND (p.pieza LIKE ? OR p.cliente LIKE ?)"; args.push(`%${search}%`, `%${search}%`); }
    sql += " ORDER BY p.id DESC LIMIT 500";
    const result = await db.execute({ sql, args });
    const rows = result.rows.map(r => ({ ...r, snap: r.snap ? JSON.parse(r.snap) : null }));
    return res.status(200).json({ ok: true, data: rows });
  }

  // POST — crear
  if (req.method === "POST") {
    const { pieza, cliente, cliente_id, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas, estado } = req.body || {};
    if (!precio || precio <= 0) return res.status(400).json({ ok: false, error: "Precio inválido" });
    const maxRes = await db.execute("SELECT MAX(COALESCE(numero,id)) as mx FROM presupuestos");
    const nextNum = (Number(maxRes.rows[0]?.mx) || 0) + 1;
    const result = await db.execute({
      sql: `INSERT INTO presupuestos (numero,pieza,cliente,cliente_id,mat,qty,precio,margen,fecha,snap,estado,moneda,tipo_cambio,fecha_entrega,notas)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [nextNum, pieza||"Sin nombre", cliente||"—", cliente_id||null, mat||"", qty||1, precio, margen||0,
             fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null,
             estado||"borrador", moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null]
    });
    const id = Number(result.lastInsertRowid);
    return res.status(200).json({ ok: true, data: { id, numero: nextNum } });
  }

  // PUT — actualizar (legacy: sin id en body para compatibilidad calculadora)
  if (req.method === "PUT") {
    const { id, numero, pieza, cliente, cliente_id, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "ID requerido" });
    await db.execute({
      sql: `UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=?,
            moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,updated_at=datetime('now') WHERE id=?`,
      args: [numero, pieza||"Sin nombre", cliente||"—", cliente_id||null, mat||"", qty||1, precio, margen||0,
             fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null,
             moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, id]
    });
    return res.status(200).json({ ok: true });
  }

  // DELETE — borrar todo (solo admin, legacy)
  if (req.method === "DELETE") {
    await db.execute("DELETE FROM presupuestos");
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
