import { getDB } from "./_lib/db.js";
import { getToken, verifyToken, requireAuth, logAction } from "./_lib/auth.js";

const TODOS_ESTADOS = ["sin_enviar","enviado","aprobado","produccion","listo","entregado","cobrado","rechazado","cancelado"];

// Un vendedor solo puede tocar presupuestos asignados a su propia ficha
function vendedorPuede(user, pres) {
  if (!user || user.rol !== "vendedor") return true;
  return Number(pres?.vendedor_id) === Number(user.vendedor_id);
}
const ESTADOS_PRODUCCION = ["produccion","listo","entregado","cobrado"];

// Restaura el stock descontado de un presupuesto y resetea los flags para poder volver a descontar
async function restaurarStockInsumos(db, presId, pieza, numero, userId) {
  try {
    const r = await db.execute({ sql: "SELECT snap, costos_internos FROM presupuestos WHERE id=?", args: [presId] });
    const pres = r.rows[0]; if (!pres) return;
    const ref = `Revertido · Pres. #${String(numero||presId).padStart(4,'0')}: ${pieza}`;

    // Restaurar snap._insumos (calculadora)
    if (pres.snap) {
      const snap = JSON.parse(pres.snap);
      if (snap._insumos && snap._insumosDeducted) {
        for (const ins of snap._insumos) {
          if (ins.id && ins.qty > 0) {
            await db.execute({ sql: "UPDATE insumos SET stock=stock+? WHERE id=? AND activo=1", args: [Number(ins.qty), ins.id] });
            try {
              const st = await db.execute({ sql: "SELECT stock FROM insumos WHERE id=?", args: [ins.id] });
              await db.execute({ sql: "INSERT INTO stock_movimientos (insumo_id,cantidad,stock_resultante,tipo,referencia,presupuesto_id,fecha,created_by) VALUES (?,?,?,?,?,?,date('now'),?)", args: [ins.id, Number(ins.qty), Number(st.rows[0]?.stock||0), "restauracion", ref, presId, userId] });
            } catch {}
          }
        }
        snap._insumosDeducted = false;
        await db.execute({ sql: "UPDATE presupuestos SET snap=? WHERE id=?", args: [JSON.stringify(snap), presId] });
      }
    }

    // Restaurar costos_internos (form de presupuestos) — excluye ítems de calculadora (ifromCalc)
    if (pres.costos_internos) {
      const costos = JSON.parse(pres.costos_internos);
      let hubo = false;
      for (const c of costos.filter(c => c.iid && c.iqty > 0 && c.ideducted && !c.ifromCalc)) {
        const qtr = c.iqty_deducted != null ? Number(c.iqty_deducted) : Number(c.iqty);
        if (qtr <= 0) continue;
        await db.execute({ sql: "UPDATE insumos SET stock=stock+? WHERE id=? AND activo=1", args: [qtr, c.iid] });
        try {
          const st = await db.execute({ sql: "SELECT stock FROM insumos WHERE id=?", args: [c.iid] });
          await db.execute({ sql: "INSERT INTO stock_movimientos (insumo_id,cantidad,stock_resultante,tipo,referencia,presupuesto_id,fecha,created_by) VALUES (?,?,?,?,?,?,date('now'),?)", args: [c.iid, qtr, Number(st.rows[0]?.stock||0), "restauracion", ref, presId, userId] });
        } catch {}
        c.ideducted = false; c.iqty_deducted = 0;
        hubo = true;
      }
      if (hubo) await db.execute({ sql: "UPDATE presupuestos SET costos_internos=? WHERE id=?", args: [JSON.stringify(costos), presId] });
    }

    // Eliminar gastos automáticos generados al producir
    await db.execute({ sql: "DELETE FROM gastos WHERE presupuesto_id=? AND tipo='produccion_automatico'", args: [presId] });
  } catch {}
}

const FLUJO = {
  sin_enviar: TODOS_ESTADOS, borrador: TODOS_ESTADOS, enviado: TODOS_ESTADOS,
  aprobado: TODOS_ESTADOS, produccion: TODOS_ESTADOS, listo: TODOS_ESTADOS,
  entregado: TODOS_ESTADOS, cobrado: TODOS_ESTADOS,
  rechazado: TODOS_ESTADOS, cancelado: TODOS_ESTADOS
};

// Elimina el ingreso automático a Caja de un presupuesto (datos viejos). Devuelve el monto retirado (0 si no había).
async function quitarIngresoCajaAuto(db, presId) {
  try {
    const r = await db.execute({ sql: "SELECT id, monto FROM caja_movimientos WHERE ref_tipo='presupuesto' AND ref_id=? AND tipo='ingreso'", args: [presId] });
    let total = 0;
    for (const mv of r.rows) {
      await db.execute({ sql: "DELETE FROM caja_movimientos WHERE id=?", args: [mv.id] });
      total += Number(mv.monto) || 0;
    }
    return total;
  } catch { return 0; }
}

async function resolveCliente(db, body) {
  const nombre = (body.cliente_nombre || body.cliente || "").trim();
  if (!nombre || nombre === "—") return null;
  const r = await db.execute({ sql: "SELECT id FROM clientes WHERE LOWER(nombre)=LOWER(?) OR (empresa IS NOT NULL AND LOWER(empresa)=LOWER(?))", args: [nombre, nombre] });
  if (r.rows[0]) return Number(r.rows[0].id);
  const tipo = body.cliente_tipo || "persona";
  const ins = await db.execute({ sql: "INSERT INTO clientes (nombre,email,telefono,tipo,empresa,rut,direccion,created_by) VALUES (?,?,?,?,?,?,?,?)", args: [nombre, body.cliente_email||null, body.cliente_tel||null, tipo, body.cliente_empresa||null, body.cliente_rut||null, body.cliente_dir||null, user?.id||null] });
  return Number(ins.lastInsertRowid);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const { id, action } = req.query;

  // /api/presupuestos/:id/duplicar
  if (id && action === "duplicar") {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
    const user = await requireAuth(req, res, db);
    if (!user) return;
    const r = await db.execute({ sql: "SELECT * FROM presupuestos WHERE id=?", args: [id] });
    const orig = r.rows[0];
    if (!orig) return res.status(404).json({ ok: false, error: "No encontrado" });

    // Resetear flag de insumos descontados en el snap
    let snapData = null;
    if (orig.snap) {
      try {
        const s = JSON.parse(orig.snap);
        s._insumosDeducted = false;
        snapData = JSON.stringify(s);
      } catch { snapData = orig.snap; }
    }

    // Resetear flags de deducción en costos_internos
    let costosData = null;
    if (orig.costos_internos) {
      try {
        const costos = JSON.parse(orig.costos_internos);
        costosData = JSON.stringify(costos.map(c => ({ ...c, ideducted: false, iqty_deducted: null })));
      } catch { costosData = orig.costos_internos; }
    }

    const maxRes = await db.execute("SELECT MAX(COALESCE(numero,id)) as mx FROM presupuestos");
    const nextNum = (Number(maxRes.rows[0]?.mx) || 0) + 1;
    const hoy = new Date().toLocaleDateString("es-UY");

    const ins = await db.execute({
      sql: "INSERT INTO presupuestos (numero,pieza,cliente,cliente_id,mat,qty,precio,margen,fecha,snap,estado,moneda,tipo_cambio,notas,vendedor_id,costos_internos,cliente_tipo,cliente_empresa,cliente_rut,alto,ancho,profundo,peso) VALUES (?,?,?,?,?,?,?,?,?,?,'sin_enviar',?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [nextNum, orig.pieza, orig.cliente, orig.cliente_id, orig.mat, orig.qty, orig.precio, orig.margen, hoy, snapData, orig.moneda, orig.tipo_cambio, orig.notas, orig.vendedor_id, costosData, orig.cliente_tipo, orig.cliente_empresa, orig.cliente_rut, orig.alto, orig.ancho, orig.profundo, orig.peso]
    });
    const newId = Number(ins.lastInsertRowid);
    await logAction(db, user, "DUPLICAR_PRESUPUESTO", "presupuesto", newId, { origen_id: Number(id) });
    return res.status(200).json({ ok: true, data: { id: newId, numero: nextNum } });
  }

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
    const user = await requireAuth(req, res, db, ["admin", "operador", "vendedor"]);
    if (!user) return;
    const { estado_nuevo, nota } = req.body || {};
    const r = await db.execute({ sql: "SELECT estado,pieza,numero,snap,precio,margen,cliente_id,moneda,costos_internos,vendedor_id FROM presupuestos WHERE id=?", args: [id] });
    const pres = r.rows[0];
    if (!pres) return res.status(404).json({ ok: false, error: "Presupuesto no encontrado" });
    if (!vendedorPuede(user, pres)) return res.status(403).json({ ok: false, error: "Sin permiso sobre este presupuesto" });
    const estado_actual = pres.estado || "borrador";
    const permitidos = FLUJO[estado_actual] || [];
    if (!permitidos.includes(estado_nuevo)) {
      return res.status(400).json({ ok: false, error: `No se puede pasar de '${estado_actual}' a '${estado_nuevo}'` });
    }
    await db.execute({ sql: "UPDATE presupuestos SET estado=?,updated_at=datetime('now'),updated_by=? WHERE id=?", args: [estado_nuevo, user.id, id] });
    await db.execute({ sql: "INSERT INTO presupuesto_estados (presupuesto_id,estado_anterior,estado_nuevo,nota,usuario_id,usuario_nombre) VALUES (?,?,?,?,?,?)", args: [id, estado_actual, estado_nuevo, nota||null, user.id, user.nombre] });
    // Auto-cobro al marcar como cobrado (si queda saldo pendiente)
    let cajaIngreso = 0, cajaRetirado = 0;
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
      // La comisión del vendedor (% sobre la utilidad cobrada) se calcula dinámicamente
      // por vendedor en /api/vendedores — no se hace ningún traspaso automático a Caja acá.
    }
    // Al revertir desde cobrado: eliminar el cobro auto-generado y el ingreso automático a Caja
    if (estado_actual === "cobrado" && estado_nuevo !== "cobrado") {
      try {
        await db.execute({ sql: "DELETE FROM cobros WHERE presupuesto_id=? AND nota='[auto] Estado → cobrado'", args: [id] });
      } catch {}
      cajaRetirado = await quitarIngresoCajaAuto(db, id);
    }

    // Registrar gastos y descontar insumos al pasar a producción o listo (lo que ocurra primero)
    const esProduccionOListo = ["produccion", "listo"].includes(estado_nuevo);

    if (esProduccionOListo && pres.snap) {
      try {
        const snap = JSON.parse(pres.snap);
        // Registrar gastos del snap (calculadora) — solo en produccion para no duplicar
        if (estado_nuevo === "produccion") {
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
        }
        // Descontar insumos del stock (solo una vez — en el primer estado elegible)
        if (snap._insumos && !snap._insumosDeducted) {
          const num = String(pres.numero||id).padStart(4,'0');
          const ref = `Pres. #${num}: ${pres.pieza}`;
          for (const ins of snap._insumos) {
            if (ins.id && ins.qty > 0) {
              const st = await db.execute({ sql: "SELECT stock FROM insumos WHERE id=?", args: [ins.id] });
              const prev = Number(st.rows[0]?.stock || 0);
              const nuevo = Math.max(0, prev - Number(ins.qty));
              await db.execute({ sql: "UPDATE insumos SET stock=? WHERE id=? AND activo=1", args: [nuevo, ins.id] });
              try { await db.execute({ sql: "INSERT INTO stock_movimientos (insumo_id,cantidad,stock_resultante,tipo,referencia,presupuesto_id,fecha,created_by) VALUES (?,?,?,?,?,?,date('now'),?)", args: [ins.id, -Number(ins.qty), nuevo, "consumo_presupuesto", ref, id, user.id] }); } catch {}
            }
          }
          snap._insumosDeducted = true;
          await db.execute({ sql: "UPDATE presupuestos SET snap=? WHERE id=?", args: [JSON.stringify(snap), id] });
        }
      } catch {}
    }

    // Descontar insumos vinculados desde el formulario de presupuestos (costos_internos)
    if (esProduccionOListo && pres.costos_internos) {
      try {
        const costos = JSON.parse(pres.costos_internos);
        // Excluir ítems de calculadora (stock ya manejado por snap)
        const porDescontar = costos.filter(c => c.iid && c.iqty > 0 && !c.ideducted && !c.ifromCalc);
        if (porDescontar.length > 0) {
          const fecha = new Date().toLocaleDateString("es-UY");
          const num = String(pres.numero||id).padStart(4,'0');
          const ref = `Pres. #${num}: ${pres.pieza}`;
          for (const c of porDescontar) {
            const st = await db.execute({ sql: "SELECT stock FROM insumos WHERE id=?", args: [c.iid] });
            const prev = Number(st.rows[0]?.stock || 0);
            const nuevo = Math.max(0, prev - Number(c.iqty));
            await db.execute({ sql: "UPDATE insumos SET stock=? WHERE id=? AND activo=1", args: [nuevo, c.iid] });
            try { await db.execute({ sql: "INSERT INTO stock_movimientos (insumo_id,cantidad,stock_resultante,tipo,referencia,presupuesto_id,fecha,created_by) VALUES (?,?,?,?,?,?,date('now'),?)", args: [c.iid, -Number(c.iqty), nuevo, "consumo_presupuesto", ref, id, user.id] }); } catch {}
            if (estado_nuevo === "produccion" && c.m > 0) {
              await db.execute({ sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,fecha,tipo,presupuesto_id,created_by) VALUES (?,?,?,?,?,?,?,?)", args: ["filamento", `${c.d} — Presupuesto #${id}: ${pres.pieza}`, c.m, pres.moneda||"UYU", fecha, "produccion_automatico", id, user.id] });
            }
            c.ideducted = true;
            c.iqty_deducted = Number(c.iqty); // registrar qty real descontada
          }
          await db.execute({ sql: "UPDATE presupuestos SET costos_internos=? WHERE id=?", args: [JSON.stringify(costos), id] });
        }
      } catch {}
    }
    // Si se vuelve atrás desde un estado de producción → restaurar stock y resetear flags
    if (ESTADOS_PRODUCCION.includes(estado_actual) && !ESTADOS_PRODUCCION.includes(estado_nuevo)) {
      await restaurarStockInsumos(db, id, pres.pieza, pres.numero, user.id);
    }

    await logAction(db, user, "CAMBIAR_ESTADO", "presupuesto", id, { estado_actual, estado_nuevo, nota });
    return res.status(200).json({ ok: true, data: { estado: estado_nuevo, caja_ingreso: cajaIngreso || undefined, caja_retirado: cajaRetirado || undefined } });
  }

  // /api/presupuestos/:id
  if (id) {
    const db2 = db;
    if (req.method === "GET") {
      const user = await requireAuth(req, res, db2);
      if (!user) return;
      const r = await db2.execute({ sql: "SELECT p.*, COALESCE(p.numero,p.id) as numero_display, c.nombre as cliente_nombre, v.nombre as vendedor_nombre FROM presupuestos p LEFT JOIN clientes c ON c.id=p.cliente_id LEFT JOIN vendedores v ON v.id=p.vendedor_id WHERE p.id=?", args: [id] });
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
      const pres = { ...r.rows[0], snap: r.rows[0].snap ? JSON.parse(r.rows[0].snap) : null };
      const cobros = await db2.execute({ sql: "SELECT * FROM cobros WHERE presupuesto_id=? ORDER BY fecha DESC", args: [id] });
      const estados = await db2.execute({ sql: "SELECT * FROM presupuesto_estados WHERE presupuesto_id=? ORDER BY id DESC", args: [id] });
      return res.status(200).json({ ok: true, data: { ...pres, cobros: cobros.rows, estados: estados.rows } });
    }
    if (req.method === "PUT") {
      const user = await requireAuth(req, res, db2);
      if (!user) return;
      if (user.rol === "vendedor") {
        const own = await db2.execute({ sql: "SELECT vendedor_id FROM presupuestos WHERE id=?", args: [id] });
        if (!vendedorPuede(user, own.rows[0])) return res.status(403).json({ ok: false, error: "Sin permiso sobre este presupuesto" });
      }
      const { numero, pieza, cliente, cliente_id, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas, vendedor_id, costos_internos, cliente_tipo, cliente_empresa, cliente_rut, alto, ancho, profundo, peso } = req.body || {};

      // ── Delta de stock al editar en estados post-producción (listo/entregado/cobrado) ──
      // Solo ítems regulares del modal (ifromCalc excluidos — el snap los maneja)
      const ESTADOS_AJUSTE = ["listo", "entregado", "cobrado"];
      let costos_internos_final = costos_internos || null;
      try {
        const curR = await db2.execute({ sql: "SELECT estado, costos_internos, numero, pieza FROM presupuestos WHERE id=?", args: [id] });
        const cur = curR.rows[0];
        if (ESTADOS_AJUSTE.includes(cur?.estado) && costos_internos != null) {
          let oldCostos = [];
          try { oldCostos = cur.costos_internos ? JSON.parse(cur.costos_internos) : []; } catch {}
          const newCostos = JSON.parse(costos_internos);

          // Qty ya descontada por iid (solo ítems regulares)
          const oldDeducted = {};
          for (const c of oldCostos.filter(c => c.iid && !c.ifromCalc && (c.ideducted || (c.iqty_deducted > 0)))) {
            const q = c.iqty_deducted != null ? Number(c.iqty_deducted) : Number(c.iqty)||0;
            oldDeducted[c.iid] = (oldDeducted[c.iid] || 0) + q;
          }

          // Nueva qty por iid (solo ítems regulares)
          const newQty = {};
          for (const c of newCostos.filter(c => c.iid && !c.ifromCalc && c.iqty > 0)) {
            newQty[c.iid] = (newQty[c.iid] || 0) + Number(c.iqty);
          }

          // Aplicar delta al stock
          const allIids = new Set([...Object.keys(oldDeducted).map(Number), ...Object.keys(newQty).map(Number)]);
          const presNum = String(cur?.numero||id).padStart(4,'0');
          const ref = `Ajuste edición · Pres. #${presNum}: ${cur?.pieza||''}`;
          for (const iid of allIids) {
            const delta = (newQty[iid] || 0) - (oldDeducted[iid] || 0);
            if (Math.abs(delta) < 0.0001) continue;
            const stR = await db2.execute({ sql: "SELECT stock FROM insumos WHERE id=?", args: [iid] });
            const prev = Number(stR.rows[0]?.stock || 0);
            const nuevo = delta > 0 ? Math.max(0, prev - delta) : prev + Math.abs(delta);
            await db2.execute({ sql: "UPDATE insumos SET stock=? WHERE id=? AND activo=1", args: [nuevo, iid] });
            try {
              await db2.execute({
                sql: "INSERT INTO stock_movimientos (insumo_id,cantidad,stock_resultante,tipo,referencia,presupuesto_id,fecha,created_by) VALUES (?,?,?,?,?,?,date('now'),?)",
                args: [iid, -delta, nuevo, "ajuste_presupuesto", ref, id, user.id]
              });
            } catch {}
          }

          // Actualizar iqty_deducted en el JSON guardado (solo ítems regulares)
          const updatedCostos = newCostos.map(c =>
            (c.iid && !c.ifromCalc) ? { ...c, iqty_deducted: Number(c.iqty)||0, ideducted: true } : c
          );
          costos_internos_final = JSON.stringify(updatedCostos);
        }
      } catch {}

      // Re-snapshot del % de comisión SOLO si cambió el vendedor asignado
      // (editar otros campos no debe alterar la comisión ya fijada)
      let comisionUpd = "comision_pct=COALESCE(comision_pct, comision_pct)"; // no-op por defecto
      try {
        const prevR = await db2.execute({ sql: "SELECT vendedor_id, comision_pct FROM presupuestos WHERE id=?", args: [id] });
        const prev = prevR.rows[0];
        const nuevoVend = vendedor_id || null;
        if (Number(prev?.vendedor_id || 0) !== Number(nuevoVend || 0)) {
          let pct = null;
          if (nuevoVend) { const vr = await db2.execute({ sql: "SELECT comision_pct FROM vendedores WHERE id=?", args: [nuevoVend] }); pct = vr.rows[0]?.comision_pct ?? null; }
          comisionUpd = `comision_pct=${pct == null ? "NULL" : Number(pct)}`;
        }
      } catch {}
      // snap usa COALESCE para no borrarlo si el formulario no lo envía
      await db2.execute({
        sql: `UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=COALESCE(?,snap),moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,vendedor_id=?,${comisionUpd},costos_internos=?,cliente_tipo=?,cliente_empresa=?,cliente_rut=?,alto=?,ancho=?,profundo=?,peso=?,updated_at=datetime('now') WHERE id=?`,
        args: [numero, pieza||"Sin nombre", cliente||"—", cliente_id||null, mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, vendedor_id||null, costos_internos_final, cliente_tipo||null, cliente_empresa||null, cliente_rut||null, alto||null, ancho||null, profundo||null, peso||null, id]
      });
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      const user = await requireAuth(req, res, db2);
      if (!user) return;
      // Restaurar stock si tenía insumos descontados
      const metaR = await db2.execute({ sql: "SELECT pieza, numero, vendedor_id FROM presupuestos WHERE id=?", args: [id] });
      const meta = metaR.rows[0];
      if (meta && !vendedorPuede(user, meta)) return res.status(403).json({ ok: false, error: "Sin permiso sobre este presupuesto" });
      if (meta) await restaurarStockInsumos(db2, id, meta.pieza, meta.numero, user.id);
      // Quitar el ingreso automático a Caja (si lo tenía por estar cobrado)
      const cajaRetirado = await quitarIngresoCajaAuto(db2, id);
      await db2.execute({ sql: "DELETE FROM presupuestos WHERE id=?", args: [id] });
      await db2.execute({ sql: "DELETE FROM presupuesto_estados WHERE presupuesto_id=?", args: [id] });
      await db2.execute({ sql: "DELETE FROM cobros WHERE presupuesto_id=?", args: [id] });
      return res.status(200).json({ ok: true, data: { caja_retirado: cajaRetirado || undefined } });
    }
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  // /api/presupuestos
  if (req.method === "GET") {
    const user = await requireAuth(req, res, db);
    if (!user) return;
    const { estado, mes, cliente_id, search } = req.query || {};
    let sql = `SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.cliente_id,
      p.mat, p.qty, p.precio, p.margen, p.fecha, p.fecha_entrega,
      p.estado, p.moneda, p.notas, p.enviado_whatsapp, p.snap, p.costos_internos, p.created_at,
      p.vendedor_id,
      c.nombre as cliente_nombre, c.empresa as cliente_empresa, c.email as cliente_email, c.telefono as cliente_tel,
      v.nombre as vendedor_nombre
      FROM presupuestos p
      LEFT JOIN clientes c ON c.id=p.cliente_id
      LEFT JOIN vendedores v ON v.id=p.vendedor_id
      WHERE 1=1`;
    const args = [];
    // Vendedor: solo ve sus propios presupuestos
    if (user.rol === "vendedor") { sql += " AND p.vendedor_id=?"; args.push(user.vendedor_id || -1); }
    if (estado) { sql += " AND p.estado=?"; args.push(estado); }
    if (mes) { sql += " AND p.fecha LIKE ?"; args.push(`%${mes}%`); }
    if (cliente_id) { sql += " AND p.cliente_id=?"; args.push(cliente_id); }
    if (search) { sql += " AND (p.pieza LIKE ? OR p.cliente LIKE ?)"; args.push(`%${search}%`, `%${search}%`); }
    sql += " ORDER BY p.id DESC LIMIT 500";
    const result = await db.execute({ sql, args });
    const rows = result.rows.map(r => {
      let snapObj = null;
      try { snapObj = r.snap ? JSON.parse(r.snap) : null; } catch {}
      // Calcular costo y ganancia
      let costo = null;
      if (snapObj?._totalCost != null) costo = Number(snapObj._totalCost);
      else if (snapObj?._matC != null) costo = (snapObj._matC||0)+(snapObj._elecC||0)+(snapObj._deprC||0)+(snapObj._laborC||0);
      if (costo === null && r.costos_internos) {
        try { const c = JSON.parse(r.costos_internos); costo = c.reduce((s,x) => s+(Number(x.m)||0), 0); } catch {}
      }
      const precio = Number(r.precio||0);
      const ganancia = costo !== null ? precio - costo : (Number(r.margen||0) > 0 ? precio * Number(r.margen) / 100 : null);
      const margen_real = (ganancia !== null && precio > 0) ? Math.round((ganancia/precio)*100) : Number(r.margen||0);
      return { ...r, snap: snapObj, costo, ganancia, margen_real };
    });
    return res.status(200).json({ ok: true, data: rows });
  }

  if (req.method === "POST") {
    const user = await requireAuth(req, res, db);
    if (!user) return;
    const body = req.body || {};
    const { pieza, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas, estado } = body;
    if (!precio || precio <= 0) return res.status(400).json({ ok: false, error: "Precio inválido" });
    // Vendedor: el presupuesto se asigna siempre a su propia ficha (no puede crear para otro)
    const vendedor_id = user.rol === "vendedor" ? (user.vendedor_id || null) : (body.vendedor_id || null);
    // Snapshot del % de comisión vigente del vendedor (editarlo luego no afecta a este presupuesto)
    let comisionPct = null;
    if (vendedor_id) {
      try { const vr = await db.execute({ sql: "SELECT comision_pct FROM vendedores WHERE id=?", args: [vendedor_id] }); comisionPct = vr.rows[0]?.comision_pct ?? null; } catch {}
    }
    const clienteId = await resolveCliente(db, body, user);
    const clienteNombre = (body.cliente_nombre || body.cliente || "—").trim();
    const maxRes = await db.execute("SELECT MAX(COALESCE(numero,id)) as mx FROM presupuestos");
    const nextNum = (Number(maxRes.rows[0]?.mx) || 0) + 1;
    const result = await db.execute({ sql: "INSERT INTO presupuestos (numero,pieza,cliente,cliente_id,mat,qty,precio,margen,fecha,snap,estado,moneda,tipo_cambio,fecha_entrega,notas,vendedor_id,comision_pct,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [nextNum, pieza||"Sin nombre", clienteNombre, clienteId, mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, estado||"borrador", moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, vendedor_id, comisionPct, user.id] });
    const newId = Number(result.lastInsertRowid);
    return res.status(200).json({ ok: true, data: { id: newId, numero: nextNum, cliente_id: clienteId } });
  }

  if (req.method === "PUT") {
    const body = req.body || {};
    const { id: bodyId, numero, pieza, mat, qty, precio, margen, fecha, snap, moneda, tipo_cambio, fecha_entrega, notas, vendedor_id } = body;
    if (!bodyId) return res.status(400).json({ ok: false, error: "ID requerido" });
    const clienteId = body.cliente_id || (await resolveCliente(db, body));
    const clienteNombre = (body.cliente_nombre || body.cliente || "—").trim();
    await db.execute({ sql: "UPDATE presupuestos SET numero=?,pieza=?,cliente=?,cliente_id=?,mat=?,qty=?,precio=?,margen=?,fecha=?,snap=?,moneda=?,tipo_cambio=?,fecha_entrega=?,notas=?,vendedor_id=?,updated_at=datetime('now') WHERE id=?", args: [numero, pieza||"Sin nombre", clienteNombre, clienteId, mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, moneda||"UYU", tipo_cambio||null, fecha_entrega||null, notas||null, vendedor_id||null, bodyId] });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    await db.execute("DELETE FROM presupuestos");
    try { await db.execute("DELETE FROM caja_movimientos WHERE ref_tipo='presupuesto'"); } catch {}
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
