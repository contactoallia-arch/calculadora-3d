import { getDB } from "./_lib/db.js";
import { getToken, verifyToken, requireAuth, logAction } from "./_lib/auth.js";

const TODOS_ESTADOS = ["sin_enviar","enviado","aprobado","produccion","listo","entregado","cobrado","rechazado","cancelado"];
const FLUJO = {
  sin_enviar: TODOS_ESTADOS, borrador: TODOS_ESTADOS, enviado: TODOS_ESTADOS,
  aprobado: TODOS_ESTADOS, produccion: TODOS_ESTADOS, listo: TODOS_ESTADOS,
  entregado: TODOS_ESTADOS, cobrado: TODOS_ESTADOS,
  rechazado: TODOS_ESTADOS, cancelado: TODOS_ESTADOS
};

async function resolveCliente(db, body) {
  const nombre = (body.cliente_nombre || body.cliente || "").trim();
  if (!nombre || nombre === "—") return null;
  const r = await db.execute({ sql: "SELECT id FROM clientes WHERE LOWER(nombre)=LOWER(?) OR (empresa IS NOT NULL AND LOWER(empresa)=LOWER(?))", args: [nombre, nombre] });
  if (r.rows[0]) return Number(r.rows[0].id);
  const tipo = body.cliente_tipo || "persona";
  const ins = await db.execute({ sql: "INSERT INTO clientes (nombre,email,telefono,tipo,empresa,rut,direccion) VALUES (?,?,?,?,?,?,?)", args: [nombre, body.cliente_email||null, body.cliente_tel||null, tipo, body.cliente_empresa||null, body.cliente_rut||null, body.cliente_dir||null] });
  return Number(ins.lastInsertRowid);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const { id, action } = req.query;

  // /api/presupuestos/:id/estados
  if (id && action === "estados") {
    const user = await requireAuth(req, res, db);
    if (!user) return;
    const r = await db.execute({ sql: "SELECT * FROM presupuesto_estados WHERE presupuesto_id=? ORDER BY id DESC", args: [id] });
    return res.status(200).json({ ok: true, data: r.rows });
  }

  // /api/presupuestos/:id/estado
  if (id && action === "estado") {
    if (req.method !== "PUT") return res.status(405).json({ ok: false, error: "Método no permitido" });
    const user = await requireAuth(req, res, db, ["admin", "operador"]);
    if (!user) return;
    const { estado_nuevo, nota } = req.body || {};
    const r = await db.execute({ sql: "SELECT estado,pieza,snap,precio,margen,cliente_id,moneda FROM presupuestos WHERE id=?", args: [id] });
    const pres = r.rows[0];
    if (!pres) return res.status(404).json({ ok: false, error: "Presupuesto no encontrado" });
    const estado_actual = pres.estado || "borrador";
    const permitidos = FLUJO[estado_actual] || [];
    if (!permitidos.includes(estado_nuevo)) {
      return res.status(400).json({ ok: false, error: `No se puede pasar de '${estado_actual}' a '${estado_nuevo}'` });
    }
    await db.execute({ sql: "UPDATE presupuestos SET estado=?,updated_at=datetime('now'),updated_by=? WHERE id=?", args: [estado_nuevo, user.id, id] });
    await db.execute({ sql: "INSERT INTO presupuesto_estados (presupuesto_id,estado_anterior,estado_nuevo,nota,usuario_id,usuario_nombre) VALUES (?,?,?,?,?,?)", args: [id, estado_actual, estado_nuevo, nota||null, user.id, user.nombre] });
    // Auto-cobro al marcar como cobrado (si queda saldo pendiente)
    if (estado_nuevo === "cobrado") {
      try {
        const cobrRes = await db.execute({ sql: "SELECT COALESCE(SUM(monto),0) as total FROM cobros WHERE presupuesto_id=? AND nota!='[auto] Estado → cobrado'", args: [id] });
        const totalCobrado = Number(cobrRes.rows[0]?.total || 0);
        const restante = Number(pres.precio || 0) - totalCobrado;
        if (restante > 0.01) {
          const fecha = new Date().toISOString().slice(0, 10);
          await db.execute({
            sql: "INSERT INTO cobros (presupuesto_id,cliente_id,monto,moneda,medio_pago,fecha,nota,created_by) VALUES (?,?,?,?,?,?,?,?)",
            args: [id, pres.cliente_id || null, restante, pres.moneda || "UYU", "efectivo", fecha, "[auto] Estado → cobrado", user.id]
          });
        }
      } catch {}
    }
    // Al revertir desde cobrado: eliminar el cobro auto-generado
    if (estado_actual === "cobrado" && estado_nuevo !== "cobrado") {
      try {
        await db.execute({ sql: "DELETE FROM cobros WHERE presupuesto_id=? AND nota='[auto] Estado → cobrado'", args: [id] });
      } catch {}
    }

    if (estado_nuevo === "produccion" && pres.snap) {
      try {
        const snap = JSON.parse(pres.snap);
        const costos = [
          { cat: "filamento",    monto: snap._matC,   desc: "Material" },
          { cat: "electricidad", monto: snap._elecC,  desc: "Electricidad" },
          { cat: "maquinaria",   monto: snap._deprC,  desc: "Depreciación impresora" },
          { cat: "otros",        monto: snap._laborC, desc: "Mano de obra" }
        ];
        const fecha = new Date().toLocaleDateString("es-UY");
        for (const c of costos) {
          if (c.monto > 0) {
            await db.execute({ sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,fecha,tipo,presupuesto_id,created_by) VALUES (?,?,?,?,?,?,?,?)", args: [c.cat, `${c.desc} — Presupuesto #${id}: ${pres.pieza}`, c.monto, "UYU", fecha, "produccion_automatico", id, user.id] });
          }
        }
        // Descontar insumos del stock (solo una vez)
        if (snap._insumos && !snap._insumosDeducted) {
          for (const ins of snap._insumos) {
            if (ins.id && ins.qty > 0) {
              await db.execute({ sql: "UPDATE insumos SET stock=MAX(0,stock-?) WHERE id=? AND activo=1", args: [Number(ins.qty), ins.id] });
            }
          }
          snap._insumosDeducted = true;
          await db.execute({ sql: "UPDATE presupuestos SET snap=? WHERE id=?", args: [JSON.stringify(snap), id] });
        }
      } catch {}
    }
    await logAction(db, user, "CAMBIAR_ESTADO", "presupuesto", id, { estado_actual, estado_nuevo, nota });
    return res.status(200).json({ ok: true, data: { estado: estado_nuevo } });
  }

  // /api/presupuestos/:id
  if (id) {
    const db2 = db;
    if (req.method === "GET") {
      const user = await requireAuth(req, res, db2);
      if (!user) return;
      const r = await db2.execute({ sql: "SELECT p.*, COALESCE(p.numero,p.id) as numero_display, c.nombre as cliente_nombre FROM presupuestos p LEFT JOIN clientes c ON c.id=p.cliente_id WHERE p.id=?", args: [id] });
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
      const pres = { ...r.rows[0], snap: r.rows[0].snap ? JSON.parse(r.rows[0].snap) : null };
      const cobros = await db2.execute({ sql: "SELECT * FROM cobros WHERE presupuesto_id=? ORDER BY fecha DESC", args: [id] });
      const estados = await db2.execute({ sql: "SELECT * FROM presupuesto_estados WHERE presupuesto_id=? ORDER BY id DESC", args: [id] });
      return res.status(200).json({ ok: true, data: { ...pres, cobros: cobros.rows, estados: estados.rows } });
    }
    if (req.method === "PUT") {
      const user = await requireAuth(req, res, db2);
      if (!user) return;
      const { numero, pieza, cliente, cliente_id, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas } = req.body || {};
      await db2.execute({ sql: "UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=?,moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,updated_at=datetime('now') WHERE id=?", args: [numero, pieza||"Sin nombre", cliente||"—", cliente_id||null, mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, id] });
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      const user = await requireAuth(req, res, db2);
      if (!user) return;
      await db2.execute({ sql: "DELETE FROM presupuestos WHERE id=?", args: [id] });
      await db2.execute({ sql: "DELETE FROM presupuesto_estados WHERE presupuesto_id=?", args: [id] });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  // /api/presupuestos
  if (req.method === "GET") {
    const { estado, mes, cliente_id, search } = req.query || {};
    let sql = `SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.cliente_id,
      p.mat, p.qty, p.precio, p.margen, p.fecha, p.fecha_entrega,
      p.estado, p.moneda, p.notas, p.enviado_whatsapp, p.snap, p.created_at,
      c.nombre as cliente_nombre, c.empresa as cliente_empresa, c.email as cliente_email, c.telefono as cliente_tel
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

  if (req.method === "POST") {
    const body = req.body || {};
    const { pieza, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas, estado } = body;
    if (!precio || precio <= 0) return res.status(400).json({ ok: false, error: "Precio inválido" });
    const clienteId = await resolveCliente(db, body);
    const clienteNombre = (body.cliente_nombre || body.cliente || "—").trim();
    const maxRes = await db.execute("SELECT MAX(COALESCE(numero,id)) as mx FROM presupuestos");
    const nextNum = (Number(maxRes.rows[0]?.mx) || 0) + 1;
    const result = await db.execute({ sql: "INSERT INTO presupuestos (numero,pieza,cliente,cliente_id,mat,qty,precio,margen,fecha,snap,estado,moneda,tipo_cambio,fecha_entrega,notas) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [nextNum, pieza||"Sin nombre", clienteNombre, clienteId, mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, estado||"borrador", moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null] });
    const newId = Number(result.lastInsertRowid);
    return res.status(200).json({ ok: true, data: { id: newId, numero: nextNum, cliente_id: clienteId } });
  }

  if (req.method === "PUT") {
    const body = req.body || {};
    const { id: bodyId, numero, pieza, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas } = body;
    if (!bodyId) return res.status(400).json({ ok: false, error: "ID requerido" });
    const clienteId = body.cliente_id || (await resolveCliente(db, body));
    const clienteNombre = (body.cliente_nombre || body.cliente || "—").trim();
    await db.execute({ sql: "UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=?,moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,updated_at=datetime('now') WHERE id=?", args: [numero, pieza||"Sin nombre", clienteNombre, clienteId, mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, bodyId] });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    await db.execute("DELETE FROM presupuestos");
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
