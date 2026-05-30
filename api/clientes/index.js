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
    const r = await db.execute(`
      SELECT c.*,
        COUNT(DISTINCT p.id) as total_presupuestos,
        COALESCE(SUM(CASE WHEN p.estado IN ('entregado','cobrado') THEN p.precio ELSE 0 END),0) as total_facturado,
        COALESCE(SUM(co.monto),0) as total_cobrado
      FROM clientes c
      LEFT JOIN presupuestos p ON p.cliente_id=c.id
      LEFT JOIN cobros co ON co.cliente_id=c.id
      WHERE c.activo=1
      GROUP BY c.id
      ORDER BY c.nombre
    `);
    return res.status(200).json({ ok: true, data: r.rows });
  }

  if (req.method === "POST") {
    const { nombre, email, telefono, notas, tipo, empresa, rut, direccion } = req.body || {};
    if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
    const r = await db.execute({
      sql: "INSERT INTO clientes (nombre,email,telefono,notas,tipo,empresa,rut,direccion,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [nombre, email||null, telefono||null, notas||null, tipo||"persona", empresa||null, rut||null, direccion||null, user.id]
    });
    await logAction(db, user, "CREAR_CLIENTE", "cliente", Number(r.lastInsertRowid));
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
