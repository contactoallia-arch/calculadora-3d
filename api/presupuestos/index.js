import { getDB } from "../_lib/db.js";
import { getToken, verifyToken } from "../_lib/auth.js";

async function resolveCliente(db, body) {
  const nombre = (body.cliente_nombre || body.cliente || "").trim();
  if (!nombre || nombre === "—") return null;

  // Buscar cliente existente por nombre (case-insensitive)
  const r = await db.execute({
    sql: "SELECT id FROM clientes WHERE LOWER(nombre)=LOWER(?) OR (empresa IS NOT NULL AND LOWER(empresa)=LOWER(?))",
    args: [nombre, nombre]
  });
  if (r.rows[0]) return Number(r.rows[0].id);

  // Crear cliente nuevo automáticamente
  const tipo = body.cliente_tipo || "persona";
  const ins = await db.execute({
    sql: "INSERT INTO clientes (nombre,email,telefono,tipo,empresa,rut,direccion) VALUES (?,?,?,?,?,?,?)",
    args: [nombre, body.cliente_email || null, body.cliente_tel || null, tipo,
           body.cliente_empresa || null, body.cliente_rut || null, body.cliente_dir || null]
  });
  return Number(ins.lastInsertRowid);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();

  // GET — listar con filtros opcionales
  if (req.method === "GET") {
    const { estado, mes, cliente_id, search } = req.query || {};
    let sql = `SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.cliente_id,
      p.mat, p.qty, p.precio, p.margen, p.fecha, p.fecha_entrega,
      p.estado, p.moneda, p.notas, p.enviado_whatsapp, p.snap, p.created_at,
      c.nombre as cliente_nombre, c.empresa as cliente_empresa
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
    const body = req.body || {};
    const { pieza, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas, estado } = body;
    if (!precio || precio <= 0) return res.status(400).json({ ok: false, error: "Precio inválido" });

    // Auto-resolver cliente
    const clienteId = await resolveCliente(db, body);
    const clienteNombre = (body.cliente_nombre || body.cliente || "—").trim();

    const maxRes = await db.execute("SELECT MAX(COALESCE(numero,id)) as mx FROM presupuestos");
    const nextNum = (Number(maxRes.rows[0]?.mx) || 0) + 1;
    const result = await db.execute({
      sql: `INSERT INTO presupuestos (numero,pieza,cliente,cliente_id,mat,qty,precio,margen,fecha,snap,estado,moneda,tipo_cambio,fecha_entrega,notas)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [nextNum, pieza||"Sin nombre", clienteNombre, clienteId, mat||"", qty||1, precio, margen||0,
             fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null,
             estado||"borrador", moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null]
    });
    const id = Number(result.lastInsertRowid);
    return res.status(200).json({ ok: true, data: { id, numero: nextNum, cliente_id: clienteId } });
  }

  // PUT — actualizar
  if (req.method === "PUT") {
    const body = req.body || {};
    const { id, numero, pieza, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas } = body;
    if (!id) return res.status(400).json({ ok: false, error: "ID requerido" });

    // Auto-resolver cliente en edición también
    const clienteId = body.cliente_id || (await resolveCliente(db, body));
    const clienteNombre = (body.cliente_nombre || body.cliente || "—").trim();

    await db.execute({
      sql: `UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=?,
            moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,updated_at=datetime('now') WHERE id=?`,
      args: [numero, pieza||"Sin nombre", clienteNombre, clienteId, mat||"", qty||1, precio, margen||0,
             fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null,
             moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, id]
    });
    return res.status(200).json({ ok: true });
  }

  // DELETE — borrar todo
  if (req.method === "DELETE") {
    await db.execute("DELETE FROM presupuestos");
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
