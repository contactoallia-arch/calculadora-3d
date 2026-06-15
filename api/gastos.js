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

  // ───────── GASTOS FIJOS (fusionado, accesible vía /api/gastos-fijos) ─────────
  if (req.query.recurso === "fijos") {
    // generar-mes
    if (req.query.action === "generar-mes") {
      if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
      const u2 = await requireAuth(req, res, db, ["admin", "operador"]);
      if (!u2) return;
      const ahora = new Date();
      const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}`;
      const cfg = await db.execute({ sql: "SELECT valor FROM configuracion WHERE clave='gastos_fijos_mes'", args: [] });
      if (cfg.rows[0]?.valor === mesActual) return res.status(200).json({ ok: false, error: `Los gastos fijos de ${mesActual} ya fueron generados` });
      const fijos = await db.execute("SELECT * FROM gastos_fijos WHERE activo=1");
      let generados = 0;
      for (const gf of fijos.rows) {
        const dia = String(gf.dia_del_mes).padStart(2, "0");
        const fecha = `${dia}/${String(ahora.getMonth()+1).padStart(2,"0")}/${ahora.getFullYear()}`;
        await db.execute({ sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,fecha,tipo,recurrente,gasto_fijo_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)", args: [gf.categoria, gf.nombre, gf.monto, gf.moneda, fecha, "fijo_mensual", 1, gf.id, u2.id] });
        generados++;
      }
      await db.execute({ sql: "INSERT OR REPLACE INTO configuracion (clave,valor) VALUES (?,?)", args: ["gastos_fijos_mes", mesActual] });
      await logAction(db, u2, "GENERAR_GASTOS_FIJOS", "gasto", null, { mes: mesActual, cantidad: generados });
      return res.status(200).json({ ok: true, data: { generados, mes: mesActual } });
    }
    if (id) {
      const u2 = await requireAuth(req, res, db, ["admin", "operador"]);
      if (!u2) return;
      if (req.method === "PUT") {
        const { nombre, categoria, monto, moneda, dia_del_mes, activo } = req.body || {};
        await db.execute({ sql: "UPDATE gastos_fijos SET nombre=?,categoria=?,monto=?,moneda=?,dia_del_mes=?,activo=? WHERE id=?", args: [nombre, categoria||"otros", monto, moneda||"UYU", dia_del_mes||1, activo?1:0, id] });
        return res.status(200).json({ ok: true });
      }
      if (req.method === "DELETE") {
        await db.execute({ sql: "DELETE FROM gastos_fijos WHERE id=?", args: [id] });
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ ok: false, error: "Método no permitido" });
    }
    if (req.method === "GET") {
      const r = await db.execute("SELECT * FROM gastos_fijos ORDER BY dia_del_mes,nombre");
      return res.status(200).json({ ok: true, data: r.rows });
    }
    if (req.method === "POST") {
      const { nombre, categoria, monto, moneda, dia_del_mes } = req.body || {};
      if (!nombre || !monto) return res.status(400).json({ ok: false, error: "Nombre y monto requeridos" });
      const r = await db.execute({ sql: "INSERT INTO gastos_fijos (nombre,categoria,monto,moneda,dia_del_mes) VALUES (?,?,?,?,?)", args: [nombre, categoria||"otros", monto, moneda||"UYU", dia_del_mes||1] });
      return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
    }
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  if (id) {
    const user2 = await requireAuth(req, res, db, ["admin", "operador", "vendedor"]);
    if (!user2) return;
    // Aprobar / rechazar un gasto pendiente (solo admin)
    if (req.method === "PUT" && (req.body?.accion === "aprobar" || req.body?.accion === "rechazar")) {
      if (user2.rol !== "admin") return res.status(403).json({ ok: false, error: "Solo un administrador puede aprobar gastos" });
      const g = await db.execute({ sql: "SELECT * FROM gastos WHERE id=?", args: [id] });
      const gasto = g.rows[0];
      if (!gasto) return res.status(404).json({ ok: false, error: "Gasto no encontrado" });
      if (req.body.accion === "rechazar") {
        await db.execute({ sql: "DELETE FROM gastos WHERE id=?", args: [id] });
        await logAction(db, user2, "RECHAZAR_GASTO", "gasto", id);
        return res.status(200).json({ ok: true, data: { rechazado: true } });
      }
      await db.execute({ sql: "UPDATE gastos SET aprobado=1,aprobado_por=?,aprobado_at=datetime('now') WHERE id=?", args: [user2.id, id] });
      // Si el gasto sale de Caja → recién ahora impacta la Caja
      if (gasto.origen === "caja") {
        try {
          await db.execute(`CREATE TABLE IF NOT EXISTS caja_movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL DEFAULT 'ingreso', concepto TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0, moneda TEXT DEFAULT 'UYU', fecha TEXT NOT NULL, ref_tipo TEXT, ref_id INTEGER, notas TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
          const fechaCaja = (gasto.fecha && gasto.fecha.includes('-')) ? gasto.fecha : new Date().toISOString().slice(0,10);
          await db.execute({ sql: "INSERT INTO caja_movimientos (tipo,concepto,monto,fecha,ref_tipo,ref_id,created_by) VALUES ('egreso',?,?,?,?,?,?)", args: [`Gasto: ${gasto.descripcion}`, Number(gasto.monto), fechaCaja, "gasto", Number(id), user2.id] });
        } catch {}
      }
      await logAction(db, user2, "APROBAR_GASTO", "gasto", id);
      return res.status(200).json({ ok: true });
    }
    // Edición / borrado: vendedor solo puede tocar sus propios gastos aún pendientes
    if (user2.rol === "vendedor") {
      const own = await db.execute({ sql: "SELECT created_by, aprobado FROM gastos WHERE id=?", args: [id] });
      const g = own.rows[0];
      if (!g || Number(g.created_by) !== Number(user2.id)) return res.status(403).json({ ok: false, error: "Sin permiso" });
      if (Number(g.aprobado) === 1) return res.status(403).json({ ok: false, error: "El gasto ya fue aprobado y no se puede modificar" });
    }
    if (req.method === "PUT") {
      const { categoria, descripcion, para_que, monto, moneda, fecha, tipo_cambio, medio_pago } = req.body || {};
      await db.execute({ sql: "UPDATE gastos SET categoria=?,descripcion=?,para_que=?,monto=?,moneda=?,tipo_cambio=?,fecha=?,medio_pago=? WHERE id=?", args: [categoria||"otros", descripcion, para_que||null, monto, moneda||"UYU", tipo_cambio||null, fecha, medio_pago||"efectivo", id] });
      await logAction(db, user2, "EDITAR_GASTO", "gasto", id);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      await db.execute({ sql: "DELETE FROM gastos WHERE id=?", args: [id] });
      await logAction(db, user2, "ELIMINAR_GASTO", "gasto", id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  if (req.method === "GET") {
    if (id) {
      const r = await db.execute({ sql: "SELECT g.*, COALESCE(p.numero,p.id) as pres_numero, p.pieza as pres_pieza FROM gastos g LEFT JOIN presupuestos p ON p.id=g.presupuesto_id WHERE g.id=?", args: [id] });
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
      return res.status(200).json({ ok: true, data: r.rows[0] });
    }
    const { mes, categoria, tipo, presupuesto_id, desde, hasta, pendientes } = req.query || {};
    let sql = `SELECT g.*, COALESCE(p.numero,p.id) as pres_numero, p.pieza as pres_pieza, u.nombre as creado_por_nombre
               FROM gastos g
               LEFT JOIN presupuestos p ON p.id=g.presupuesto_id
               LEFT JOIN usuarios u ON u.id=g.created_by
               WHERE 1=1`;
    const args = [];
    // Vendedor: solo ve sus propios gastos
    if (user.rol === "vendedor") { sql += " AND g.created_by=?"; args.push(user.id); }
    // Admin puede pedir solo los pendientes de aprobación
    if (pendientes) { sql += " AND COALESCE(g.aprobado,1)=0"; }
    if (mes) {
      const [anio, mm] = mes.split("-");
      sql += " AND (g.fecha LIKE ? OR g.fecha LIKE ? OR g.fecha LIKE ?)";
      args.push(`${anio}-${mm}%`, `%/${mm}/${anio}`, `%/${mm}/${anio}%`);
    }
    if (desde) { sql += " AND g.fecha >= ?"; args.push(desde); }
    if (hasta) { sql += " AND g.fecha <= ?"; args.push(hasta); }
    if (categoria) { sql += " AND g.categoria=?"; args.push(categoria); }
    if (tipo) { sql += " AND g.tipo=?"; args.push(tipo); }
    if (presupuesto_id) { sql += " AND g.presupuesto_id=?"; args.push(presupuesto_id); }
    sql += " ORDER BY g.fecha DESC, g.id DESC LIMIT 500";
    const r = await db.execute({ sql, args });
    return res.status(200).json({ ok: true, data: r.rows });
  }

  if (req.method === "POST") {
    const { categoria, descripcion, para_que, monto, moneda, tipo_cambio, fecha, tipo, presupuesto_id, recurrente, gasto_fijo_id, medio_pago, origen, pagado_por } = req.body || {};
    if (!descripcion || !monto) return res.status(400).json({ ok: false, error: "Descripción y monto requeridos" });
    // Vendedor: el gasto queda PENDIENTE de aprobación y nunca toca la Caja hasta que un admin lo apruebe
    const esVend = user.rol === "vendedor";
    const origenFinal = esVend ? "personal" : (origen || "empresa");
    const aprobado = esVend ? 0 : 1;
    const r = await db.execute({
      sql: "INSERT INTO gastos (categoria,descripcion,para_que,monto,moneda,tipo_cambio,fecha,tipo,presupuesto_id,recurrente,gasto_fijo_id,medio_pago,origen,pagado_por,created_by,aprobado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [categoria||"otros", descripcion, para_que||null, monto, moneda||"UYU", tipo_cambio||null,
             fecha||new Date().toLocaleDateString("es-UY"), tipo||"manual",
             presupuesto_id||null, recurrente?1:0, gasto_fijo_id||null, medio_pago||"efectivo",
             origenFinal, esVend ? user.id : (pagado_por||null), user.id, aprobado]
    });
    const newId = Number(r.lastInsertRowid);
    if (esVend) { await logAction(db, user, "CREAR_GASTO_PENDIENTE", "gasto", newId); return res.status(200).json({ ok: true, data: { id: newId, pendiente: true } }); }
    // Si el gasto sale de Caja → crear egreso automáticamente
    if (origenFinal === "caja") {
      try {
        await db.execute(`CREATE TABLE IF NOT EXISTS caja_movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL DEFAULT 'ingreso', concepto TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0, moneda TEXT DEFAULT 'UYU', fecha TEXT NOT NULL, ref_tipo TEXT, ref_id INTEGER, notas TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
        const fechaCaja = (fecha && fecha.includes('-')) ? fecha : new Date().toISOString().slice(0,10);
        await db.execute({
          sql: "INSERT INTO caja_movimientos (tipo,concepto,monto,fecha,ref_tipo,ref_id,created_by) VALUES ('egreso',?,?,?,?,?,?)",
          args: [`Gasto: ${descripcion}`, Number(monto), fechaCaja, "gasto", newId, user.id]
        });
      } catch {}
    }
    await logAction(db, user, "CREAR_GASTO", "gasto", newId);
    return res.status(200).json({ ok: true, data: { id: newId } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
