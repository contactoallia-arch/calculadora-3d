import { getDB } from "./_lib/db.js";
import { requireAuth, logAction } from "./_lib/auth.js";

// Calcula la utilidad de un presupuesto individual
function calcUtilidad(p) {
  const precio = Number(p.precio) || 0;
  if (p.costos_internos) {
    try {
      const costos = JSON.parse(p.costos_internos);
      const totalCostos = costos.reduce((s, c) => s + (Number(c.m) || 0), 0);
      return precio - totalCostos;
    } catch {}
  }
  const margen = Number(p.margen) || 0;
  return precio * (margen / 100);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const { id } = req.query;

  // ── PUT /api/repartos/:id  (ejecutar o cancelar) ─────────────────────
  if (id && req.method === "PUT") {
    const { accion, executed_at } = req.body || {};
    const r = await db.execute({ sql: "SELECT * FROM repartos WHERE id=?", args: [id] });
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
    const rep = r.rows[0];
    if (rep.estado === "ejecutado") return res.status(400).json({ ok: false, error: "Ya fue ejecutado" });
    const nuevoEstado = accion === "ejecutar" ? "ejecutado" : "cancelado";
    const ahora = executed_at || new Date().toISOString().slice(0, 10);
    await db.execute({
      sql: "UPDATE repartos SET estado=?, executed_at=? WHERE id=?",
      args: [nuevoEstado, nuevoEstado === "ejecutado" ? ahora : null, id]
    });
    await logAction(db, user, nuevoEstado === "ejecutado" ? "EJECUTAR_REPARTO" : "CANCELAR_REPARTO", "reparto", id);
    return res.status(200).json({ ok: true });
  }

  // ── DELETE /api/repartos/:id ─────────────────────────────────────────
  if (id && req.method === "DELETE") {
    const r = await db.execute({ sql: "SELECT estado FROM repartos WHERE id=?", args: [id] });
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
    if (r.rows[0].estado === "ejecutado") return res.status(400).json({ ok: false, error: "No se puede eliminar un reparto ejecutado" });
    await db.execute({ sql: "DELETE FROM repartos WHERE id=?", args: [id] });
    await logAction(db, user, "ELIMINAR_REPARTO", "reparto", id);
    return res.status(200).json({ ok: true });
  }

  // ── GET /api/repartos ────────────────────────────────────────────────
  if (req.method === "GET") {
    // 1. Listar repartos
    const rep = await db.execute("SELECT * FROM repartos ORDER BY created_at DESC");

    // 2. Calcular bolsa de utilidades desde presupuestos cobrados
    const pres = await db.execute(
      "SELECT precio, margen, costos_internos, pieza, numero, id FROM presupuestos WHERE estado='cobrado'"
    );
    let total_utilidad = 0;
    const detalle_bolsa = pres.rows.map(p => {
      const u = calcUtilidad(p);
      total_utilidad += u;
      return { id: p.id, pieza: p.pieza, numero: p.numero, precio: p.precio, utilidad: u };
    }).filter(x => x.utilidad > 0);

    // 3. Calcular ejecutado y pendiente
    const ejecutado = rep.rows
      .filter(r => r.estado === "ejecutado")
      .reduce((s, r) => s + Number(r.monto), 0);
    const pendiente = rep.rows
      .filter(r => r.estado === "pendiente")
      .reduce((s, r) => s + Number(r.monto), 0);
    const disponible = total_utilidad - ejecutado;
    const disponible_libre = total_utilidad - ejecutado - pendiente;

    return res.status(200).json({
      ok: true,
      data: rep.rows,
      bolsa: { total_utilidad, ejecutado, pendiente, disponible, disponible_libre, detalle: detalle_bolsa }
    });
  }

  // ── POST /api/repartos ───────────────────────────────────────────────
  if (req.method === "POST") {
    const { descripcion, destinatario, monto, fecha, notas } = req.body || {};
    if (!descripcion || !monto) return res.status(400).json({ ok: false, error: "Descripción y monto requeridos" });
    const r = await db.execute({
      sql: "INSERT INTO repartos (descripcion, destinatario, monto, fecha, notas, estado, created_by) VALUES (?,?,?,?,?,'pendiente',?)",
      args: [descripcion, destinatario || null, Number(monto), fecha || null, notas || null, user.id]
    });
    await logAction(db, user, "CREAR_REPARTO", "reparto", Number(r.lastInsertRowid));
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
