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
    if (req.method === "GET") {
      const r = await db.execute({ sql: "SELECT * FROM clientes WHERE id=?", args: [id] });
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
      const presups = await db.execute({ sql: "SELECT id,COALESCE(numero,id) as numero,pieza,estado,precio,moneda,fecha FROM presupuestos WHERE cliente_id=? ORDER BY id DESC", args: [id] });
      return res.status(200).json({ ok: true, data: { ...r.rows[0], presupuestos: presups.rows } });
    }
    if (req.method === "PUT") {
      const { nombre, email, telefono, notas, activo, tipo, empresa, rut, direccion } = req.body || {};
      await db.execute({ sql: "UPDATE clientes SET nombre=?,email=?,telefono=?,notas=?,activo=?,tipo=?,empresa=?,rut=?,direccion=? WHERE id=?", args: [nombre, email||null, telefono||null, notas||null, activo!==undefined?activo:1, tipo||"persona", empresa||null, rut||null, direccion||null, id] });
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

  if (req.method === "GET") {
    // Subconsultas correlacionadas para evitar producto cartesiano cuando un cliente
    // tiene múltiples presupuestos Y múltiples cobros al mismo tiempo.
    // Fallback por nombre (LOWER/TRIM) para presupuestos sin cliente_id seteado.
    const r = await db.execute(`
      SELECT c.*,
        (
          SELECT COUNT(*) FROM presupuestos p
          WHERE p.cliente_id=c.id
             OR (p.cliente_id IS NULL AND LOWER(TRIM(p.cliente))=LOWER(TRIM(c.nombre)))
        ) as total_presupuestos,
        (
          SELECT COALESCE(SUM(p.precio),0) FROM presupuestos p
          WHERE (p.cliente_id=c.id OR (p.cliente_id IS NULL AND LOWER(TRIM(p.cliente))=LOWER(TRIM(c.nombre))))
            AND p.estado IN ('entregado','cobrado')
        ) as total_facturado,
        (
          SELECT COALESCE(SUM(co.monto),0) FROM cobros co
          WHERE co.presupuesto_id IN (
            SELECT p.id FROM presupuestos p
            WHERE p.cliente_id=c.id
               OR (p.cliente_id IS NULL AND LOWER(TRIM(p.cliente))=LOWER(TRIM(c.nombre)))
          )
        ) as total_cobrado
      FROM clientes c
      WHERE c.activo=1
      ORDER BY c.nombre
    `);
    return res.status(200).json({ ok: true, data: r.rows });
  }
  if (req.method === "POST") {
    const { nombre, email, telefono, notas, tipo, empresa, rut, direccion } = req.body || {};
    if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
    const r = await db.execute({ sql: "INSERT INTO clientes (nombre,email,telefono,notas,tipo,empresa,rut,direccion,created_by) VALUES (?,?,?,?,?,?,?,?,?)", args: [nombre, email||null, telefono||null, notas||null, tipo||"persona", empresa||null, rut||null, direccion||null, user.id] });
    await logAction(db, user, "CREAR_CLIENTE", "cliente", Number(r.lastInsertRowid));
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
