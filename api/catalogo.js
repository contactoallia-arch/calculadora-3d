import { getDB } from "./_lib/db.js";
import { requireAuth, logAction } from "./_lib/auth.js";

// Router consolidado: insumos, productos, proveedores, agenda, notificaciones
// Se accede vía /api/<recurso> (rewrites en vercel.json → /api/catalogo?recurso=<recurso>)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const recurso = req.query.recurso;
  const id = req.query.id;
  const m = req.method;

  try {
    // ───────────────────────── INSUMOS ─────────────────────────
    if (recurso === "insumos") {
      if (m === "GET") {
        const categoria = req.query.categoria;
        const args = [];
        let sqlBase = `SELECT i.*, p.nombre as proveedor_nombre, mf.nombre as marca_nombre, mf.peso_tara_g as peso_tara_g FROM insumos i LEFT JOIN proveedores p ON p.id=i.proveedor_id LEFT JOIN marcas_filamento mf ON mf.id=i.marca_id WHERE i.activo=1`;
        if (categoria) { sqlBase += " AND i.categoria=?"; args.push(categoria); }
        sqlBase += " ORDER BY i.categoria, i.nombre";
        // Intentar incluir último movimiento (la tabla puede no existir aún)
        let rows;
        try {
          const sqlFull = sqlBase.replace(
            "FROM insumos i",
            `,
            (SELECT sm.referencia FROM stock_movimientos sm WHERE sm.insumo_id=i.id ORDER BY sm.id DESC LIMIT 1) as ultimo_mov_ref,
            (SELECT sm.cantidad FROM stock_movimientos sm WHERE sm.insumo_id=i.id ORDER BY sm.id DESC LIMIT 1) as ultimo_mov_qty,
            (SELECT sm.fecha FROM stock_movimientos sm WHERE sm.insumo_id=i.id ORDER BY sm.id DESC LIMIT 1) as ultimo_mov_fecha
            FROM insumos i`
          );
          rows = (await db.execute({ sql: sqlFull, args })).rows;
        } catch {
          // Fallback sin movimientos si la tabla no existe todavía
          rows = (await db.execute({ sql: sqlBase, args })).rows;
        }
        return res.status(200).json({ ok: true, data: rows });
      }
      if (m === "POST") {
        const { nombre, categoria, tipo, proveedor_id, precio, moneda, unidad, stock, notas } = req.body || {};
        if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
        // Buscar duplicado por nombre + proveedor (sin importar el precio)
        const dupArgs = [nombre];
        let dupSql = "SELECT id,nombre,stock,precio FROM insumos WHERE LOWER(nombre)=LOWER(?) AND activo=1";
        if (proveedor_id) { dupSql += " AND proveedor_id=?"; dupArgs.push(proveedor_id); }
        else dupSql += " AND proveedor_id IS NULL";
        const dup = await db.execute({ sql: dupSql, args: dupArgs });
        if (dup.rows.length) {
          const ex = dup.rows[0];
          return res.status(409).json({
            ok: false,
            duplicate: true,
            existing_id: Number(ex.id),
            existing_stock: Number(ex.stock || 0),
            existing_price: Number(ex.precio || 0),
            error: `Ya existe "${ex.nombre}" con ese proveedor`
          });
        }
        const { stock_min, marca_id } = req.body || {};
        const r = await db.execute({
          sql: "INSERT INTO insumos (nombre,categoria,tipo,proveedor_id,precio,moneda,unidad,stock,stock_min,notas,marca_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          args: [nombre, categoria||"otros", tipo||null, proveedor_id||null, precio||0, moneda||"UYU", unidad||"kg", stock||0, stock_min!=null?Number(stock_min):0.4, notas||null, marca_id||null]
        });
        const nid = Number(r.lastInsertRowid);
        await logAction(db, user, "CREAR_INSUMO", "insumo", nid);
        return res.status(200).json({ ok: true, data: { id: nid } });
      }
      if (m === "PUT" && id) {
        if (req.query.action === "add-stock") {
          const { qty, precio, referencia, tipo } = req.body || {};
          const delta = Number(qty)||0;
          const stockRes = await db.execute({ sql: "SELECT stock FROM insumos WHERE id=?", args: [id] });
          const stockActual = Number(stockRes.rows[0]?.stock || 0);
          const stockNuevo = Math.max(0, stockActual + delta);
          await db.execute({
            sql: "UPDATE insumos SET stock=?, precio=COALESCE(?,precio) WHERE id=?",
            args: [stockNuevo, precio||null, id]
          });
          try {
            await db.execute({
              sql: "INSERT INTO stock_movimientos (insumo_id,cantidad,stock_resultante,tipo,referencia,fecha,created_by) VALUES (?,?,?,?,?,date('now'),?)",
              args: [id, delta, stockNuevo, tipo||'manual', referencia||null, user?.id||null]
            });
          } catch {}
          await logAction(db, user, "STOCK_INSUMO", "insumo", id);
          return res.status(200).json({ ok: true });
        }
        const { nombre, categoria, tipo, proveedor_id, precio, moneda, unidad, stock, stock_min, notas, marca_id } = req.body || {};
        await db.execute({
          sql: "UPDATE insumos SET nombre=?,categoria=?,tipo=?,proveedor_id=?,precio=?,moneda=?,unidad=?,stock=?,stock_min=?,notas=?,marca_id=? WHERE id=?",
          args: [nombre, categoria||"otros", tipo||null, proveedor_id||null, precio||0, moneda||"UYU", unidad||"kg", stock||0, stock_min!=null?Number(stock_min):null, notas||null, marca_id||null, id]
        });
        await logAction(db, user, "EDITAR_INSUMO", "insumo", id);
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "UPDATE insumos SET activo=0 WHERE id=?", args: [id] });
        await logAction(db, user, "ELIMINAR_INSUMO", "insumo", id);
        return res.status(200).json({ ok: true });
      }
    }

    // ───────────────────────── MARCAS DE FILAMENTO ─────────────────────────
    if (recurso === "marcas-filamento") {
      if (m === "GET") {
        const r = await db.execute("SELECT * FROM marcas_filamento WHERE activo=1 ORDER BY nombre");
        return res.status(200).json({ ok: true, data: r.rows });
      }
      if (m === "POST") {
        const { nombre, peso_tara_g } = req.body || {};
        if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
        const r = await db.execute({ sql: "INSERT INTO marcas_filamento (nombre,peso_tara_g) VALUES (?,?)", args: [nombre.trim(), Number(peso_tara_g)||0] });
        return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
      }
      if (m === "PUT" && id) {
        const { nombre, peso_tara_g } = req.body || {};
        await db.execute({ sql: "UPDATE marcas_filamento SET nombre=?,peso_tara_g=? WHERE id=?", args: [nombre?.trim()||'', Number(peso_tara_g)||0, id] });
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "UPDATE marcas_filamento SET activo=0 WHERE id=?", args: [id] });
        return res.status(200).json({ ok: true });
      }
    }


    // ───────────────────────── PRODUCTOS ─────────────────────────
    if (recurso === "productos") {
      if (m === "GET") {
        const r = await db.execute("SELECT * FROM productos WHERE activo=1 ORDER BY nombre");
        return res.status(200).json({ ok: true, data: r.rows });
      }
      if (m === "POST") {
        const { nombre, descripcion, precio_base, moneda, mat, notas } = req.body || {};
        if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
        const r = await db.execute({
          sql: "INSERT INTO productos (nombre,descripcion,precio_base,moneda,mat,notas) VALUES (?,?,?,?,?,?)",
          args: [nombre, descripcion||null, precio_base||0, moneda||"UYU", mat||null, notas||null]
        });
        await logAction(db, user, "CREAR_PRODUCTO", "producto", Number(r.lastInsertRowid));
        return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
      }
      if (m === "PUT" && id) {
        const { nombre, descripcion, precio_base, moneda, mat, notas } = req.body || {};
        await db.execute({
          sql: "UPDATE productos SET nombre=?,descripcion=?,precio_base=?,moneda=?,mat=?,notas=? WHERE id=?",
          args: [nombre, descripcion||null, precio_base||0, moneda||"UYU", mat||null, notas||null, id]
        });
        await logAction(db, user, "EDITAR_PRODUCTO", "producto", id);
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "UPDATE productos SET activo=0 WHERE id=?", args: [id] });
        await logAction(db, user, "ELIMINAR_PRODUCTO", "producto", id);
        return res.status(200).json({ ok: true });
      }
    }

    // ───────────────────────── PROVEEDORES ─────────────────────────
    if (recurso === "proveedores") {
      if (m === "GET") {
        const r = await db.execute(`
          SELECT pr.*,
            (SELECT COUNT(*) FROM insumos i WHERE i.proveedor_id=pr.id AND i.activo=1) as total_pedidos,
            (SELECT COALESCE(SUM(CASE WHEN COALESCE(i.moneda,'UYU')='UYU' THEN i.precio*i.stock ELSE 0 END),0) FROM insumos i WHERE i.proveedor_id=pr.id AND i.activo=1) as total_uyu,
            (SELECT COALESCE(SUM(CASE WHEN i.moneda='USD' THEN i.precio*i.stock ELSE 0 END),0) FROM insumos i WHERE i.proveedor_id=pr.id AND i.activo=1) as total_usd
          FROM proveedores pr WHERE pr.activo=1 ORDER BY pr.nombre`);
        return res.status(200).json({ ok: true, data: r.rows });
      }
      if (m === "POST") {
        const { nombre, rubro, contacto, telefono, celular, email, rut, razon_social, direccion, vendedor, notas } = req.body || {};
        if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
        const r = await db.execute({
          sql: "INSERT INTO proveedores (nombre,rubro,contacto,telefono,celular,email,rut,razon_social,direccion,vendedor,notas) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          args: [nombre, rubro||null, contacto||null, telefono||null, celular||null, email||null, rut||null, razon_social||null, direccion||null, vendedor||null, notas||null]
        });
        await logAction(db, user, "CREAR_PROVEEDOR", "proveedor", Number(r.lastInsertRowid));
        return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
      }
      if (m === "PUT" && id) {
        const { nombre, rubro, contacto, telefono, celular, email, rut, razon_social, direccion, vendedor, notas } = req.body || {};
        await db.execute({
          sql: "UPDATE proveedores SET nombre=?,rubro=?,contacto=?,telefono=?,celular=?,email=?,rut=?,razon_social=?,direccion=?,vendedor=?,notas=? WHERE id=?",
          args: [nombre, rubro||null, contacto||null, telefono||null, celular||null, email||null, rut||null, razon_social||null, direccion||null, vendedor||null, notas||null, id]
        });
        await logAction(db, user, "EDITAR_PROVEEDOR", "proveedor", id);
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "UPDATE proveedores SET activo=0 WHERE id=?", args: [id] });
        await logAction(db, user, "ELIMINAR_PROVEEDOR", "proveedor", id);
        return res.status(200).json({ ok: true });
      }
    }

    // ───────────────────────── AGENDA ─────────────────────────
    if (recurso === "agenda") {
      if (m === "GET") {
        const { solo_mios, completados, desde, hasta } = req.query;
        let sql = `SELECT a.*, u.nombre as asignado_nombre,
          p.pieza as presupuesto_pieza, c.nombre as cliente_nombre,
          0 as es_entrega_pres
          FROM agenda a
          LEFT JOIN usuarios u ON u.id=a.asignado_a
          LEFT JOIN presupuestos p ON p.id=a.presupuesto_id
          LEFT JOIN clientes c ON c.id=a.cliente_id WHERE 1=1`;
        const args = [];
        if (solo_mios === "1") { sql += " AND a.asignado_a=?"; args.push(user.id); }
        if (!completados || completados === "0") sql += " AND a.completado=0";
        if (desde) { sql += " AND a.fecha >= ?"; args.push(desde); }
        if (hasta) { sql += " AND a.fecha <= ?"; args.push(hasta); }
        sql += " ORDER BY a.fecha ASC, a.hora ASC";
        const r = await db.execute({ sql, args });

        // Agregar eventos virtuales de presupuestos con fecha_entrega en el rango
        // fecha_entrega se guarda como DD/MM/YYYY → convertir con substr para comparar
        let virtuales = [];
        if (desde && hasta) {
          try {
            const vr = await db.execute({
              sql: `SELECT
                p.id as presupuesto_id,
                '#' || COALESCE(p.numero, p.id) || ' · ' || p.pieza as titulo,
                COALESCE(c.nombre, p.cliente) as descripcion,
                'entrega' as tipo,
                substr(p.fecha_entrega,7,4)||'-'||substr(p.fecha_entrega,4,2)||'-'||substr(p.fecha_entrega,1,2) as fecha,
                null as hora,
                0 as completado,
                1 as es_entrega_pres,
                p.estado,
                p.precio,
                p.moneda
              FROM presupuestos p
              LEFT JOIN clientes c ON c.id = p.cliente_id
              WHERE p.fecha_entrega IS NOT NULL
                AND p.fecha_entrega != ''
                AND length(p.fecha_entrega) = 10
                AND p.estado NOT IN ('cancelado','rechazado')
                AND substr(p.fecha_entrega,7,4)||'-'||substr(p.fecha_entrega,4,2)||'-'||substr(p.fecha_entrega,1,2) BETWEEN ? AND ?`,
              args: [desde, hasta]
            });
            virtuales = vr.rows;
          } catch {}
        }
        return res.status(200).json({ ok: true, data: [...r.rows, ...virtuales] });
      }
      if (m === "POST") {
        const { titulo, descripcion, tipo, fecha, hora, presupuesto_id, cliente_id, asignado_a, prioridad, notas } = req.body || {};
        if (!titulo || !fecha) return res.status(400).json({ ok: false, error: "Título y fecha requeridos" });
        const r = await db.execute({
          sql: "INSERT INTO agenda (titulo,descripcion,tipo,fecha,hora,presupuesto_id,cliente_id,asignado_a,prioridad,notas,creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          args: [titulo, descripcion||null, tipo||"tarea", fecha, hora||null, presupuesto_id||null, cliente_id||null, asignado_a||user.id, prioridad||"normal", notas||null, user.id]
        });
        const nid = Number(r.lastInsertRowid);
        if (asignado_a && Number(asignado_a) !== Number(user.id)) {
          try { await db.execute({ sql: "INSERT INTO notificaciones (usuario_id,titulo,mensaje,tipo,link_tipo,link_id) VALUES (?,?,?,?,?,?)", args: [asignado_a, `Nueva tarea: ${titulo}`, `${user.nombre} te asignó una tarea para el ${fecha}`, "tarea", "agenda", nid] }); } catch {}
        }
        await logAction(db, user, "CREAR_AGENDA", "agenda", nid);
        return res.status(200).json({ ok: true, data: { id: nid } });
      }
      if (m === "PUT" && id) {
        const { titulo, descripcion, tipo, fecha, hora, presupuesto_id, cliente_id, asignado_a, prioridad, notas, completado } = req.body || {};
        // Update parcial si solo viene completado
        if (titulo === undefined && completado !== undefined) {
          await db.execute({ sql: "UPDATE agenda SET completado=? WHERE id=?", args: [completado?1:0, id] });
          return res.status(200).json({ ok: true });
        }
        await db.execute({
          sql: "UPDATE agenda SET titulo=?,descripcion=?,tipo=?,fecha=?,hora=?,presupuesto_id=?,cliente_id=?,asignado_a=?,prioridad=?,notas=?,completado=? WHERE id=?",
          args: [titulo, descripcion||null, tipo||"tarea", fecha, hora||null, presupuesto_id||null, cliente_id||null, asignado_a||user.id, prioridad||"normal", notas||null, completado?1:0, id]
        });
        await logAction(db, user, "EDITAR_AGENDA", "agenda", id);
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "DELETE FROM agenda WHERE id=?", args: [id] });
        await logAction(db, user, "ELIMINAR_AGENDA", "agenda", id);
        return res.status(200).json({ ok: true });
      }
    }

    // ───────────────────────── NOTIFICACIONES ─────────────────────────
    if (recurso === "notificaciones") {
      if (m === "GET") {
        const r = await db.execute({ sql: "SELECT * FROM notificaciones WHERE usuario_id=? ORDER BY created_at DESC LIMIT 50", args: [user.id] });
        const noLeidas = r.rows.filter(n => !n.leida).length;
        return res.status(200).json({ ok: true, data: r.rows, noLeidas });
      }
      if (m === "PUT" && id) {
        await db.execute({ sql: "UPDATE notificaciones SET leida=1 WHERE id=? AND usuario_id=?", args: [id, user.id] });
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "DELETE FROM notificaciones WHERE id=? AND usuario_id=?", args: [id, user.id] });
        return res.status(200).json({ ok: true });
      }
    }

    // ───────────────────────── REPARTOS DE UTILIDADES ────────────────────
    if (recurso === "repartos") {
      // Auto-crear tabla si no existe (por si setup no fue llamado)
      await db.execute(`CREATE TABLE IF NOT EXISTS repartos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        descripcion TEXT NOT NULL, destinatario TEXT, monto REAL NOT NULL DEFAULT 0,
        fecha TEXT, estado TEXT NOT NULL DEFAULT 'pendiente', notas TEXT,
        created_by INTEGER, executed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
      )`);
      // Auto-agregar columna costos_internos si no existe
      try { await db.execute("ALTER TABLE presupuestos ADD COLUMN costos_internos TEXT"); } catch {}

      function calcUtilidad(p) {
        const precio = Number(p.precio) || 0;
        if (p.costos_internos) {
          try { const c = JSON.parse(p.costos_internos); const totalCostos = c.reduce((s,x)=>s+(Number(x.m)||0),0); return precio - totalCostos; } catch {}
        }
        const margen = Number(p.margen) || 0;
        if (margen > 0) return precio * (margen / 100);
        return null; // sin margen ni costos definidos
      }

      if (m === "GET") {
        const rep = await db.execute("SELECT * FROM repartos ORDER BY created_at DESC");
        const pres = await db.execute("SELECT precio,margen,costos_internos,pieza,numero,id FROM presupuestos WHERE estado='cobrado'");
        let total_utilidad = 0;
        const detalle = pres.rows.map(p => {
          const u = calcUtilidad(p);
          if (u !== null) total_utilidad += u;
          return { id:p.id, pieza:p.pieza, numero:p.numero, precio:Number(p.precio)||0, utilidad:u, sin_margen: u === null };
        }); // mostramos TODOS los cobrados aunque no tengan utilidad definida
        const ejecutado = rep.rows.filter(r=>r.estado==="ejecutado").reduce((s,r)=>s+Number(r.monto),0);
        const pendiente = rep.rows.filter(r=>r.estado==="pendiente").reduce((s,r)=>s+Number(r.monto),0);
        return res.status(200).json({ ok:true, data:rep.rows, bolsa:{total_utilidad,ejecutado,pendiente,disponible:total_utilidad-ejecutado,disponible_libre:total_utilidad-ejecutado-pendiente,detalle} });
      }
      if (m === "POST") {
        const { descripcion, destinatario, monto, fecha, notas, para_caja } = req.body||{};
        if (!descripcion||!monto) return res.status(400).json({ok:false,error:"Descripción y monto requeridos"});
        const r = await db.execute({ sql:"INSERT INTO repartos (descripcion,destinatario,monto,fecha,notas,estado,para_caja,created_by) VALUES (?,?,?,?,?,'pendiente',?,?)", args:[descripcion,destinatario||null,Number(monto),fecha||null,notas||null,para_caja?1:0,user.id] });
        await logAction(db,user,"CREAR_REPARTO","reparto",Number(r.lastInsertRowid));
        return res.status(200).json({ok:true,data:{id:Number(r.lastInsertRowid)}});
      }
      if (m === "PUT" && id) {
        const { accion } = req.body||{};
        const r = await db.execute({sql:"SELECT estado,monto,descripcion,para_caja FROM repartos WHERE id=?",args:[id]});
        if (!r.rows[0]) return res.status(404).json({ok:false,error:"No encontrado"});
        if (r.rows[0].estado==="ejecutado") return res.status(400).json({ok:false,error:"Ya fue ejecutado"});
        const nuevo = accion==="ejecutar"?"ejecutado":"cancelado";
        const hoy = new Date().toISOString().slice(0,10);
        await db.execute({sql:"UPDATE repartos SET estado=?,executed_at=? WHERE id=?",args:[nuevo,nuevo==="ejecutado"?hoy:null,id]});
        // Si se ejecuta y es para_caja → crear movimiento de caja automáticamente
        if (nuevo === "ejecutado" && r.rows[0].para_caja) {
          try {
            await db.execute(`CREATE TABLE IF NOT EXISTS caja_movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL DEFAULT 'ingreso', concepto TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0, moneda TEXT DEFAULT 'UYU', fecha TEXT NOT NULL, ref_tipo TEXT, ref_id INTEGER, notas TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
            await db.execute({
              sql: "INSERT INTO caja_movimientos (tipo,concepto,monto,fecha,ref_tipo,ref_id,created_by) VALUES ('ingreso',?,?,?,?,?,?)",
              args: [`Utilidades → Caja: ${r.rows[0].descripcion}`, Number(r.rows[0].monto), hoy, 'reparto', Number(id), user.id]
            });
          } catch {}
        }
        await logAction(db,user,nuevo==="ejecutado"?"EJECUTAR_REPARTO":"CANCELAR_REPARTO","reparto",id);
        return res.status(200).json({ok:true});
      }
      if (m === "DELETE" && id) {
        const r = await db.execute({sql:"SELECT estado FROM repartos WHERE id=?",args:[id]});
        if (!r.rows[0]) return res.status(404).json({ok:false,error:"No encontrado"});
        if (r.rows[0].estado==="ejecutado") return res.status(400).json({ok:false,error:"No se puede eliminar un reparto ejecutado"});
        await db.execute({sql:"DELETE FROM repartos WHERE id=?",args:[id]});
        await logAction(db,user,"ELIMINAR_REPARTO","reparto",id);
        return res.status(200).json({ok:true});
      }
    }

    // ───────────────────────── VENDEDORES ─────────────────────────
    if (recurso === "vendedores") {
      if (m === "GET") {
        const r = await db.execute(`
          SELECT v.*,
            (SELECT COUNT(*) FROM presupuestos p WHERE p.vendedor_id=v.id) as total_presupuestos,
            (SELECT COUNT(*) FROM presupuestos p WHERE p.vendedor_id=v.id
               AND p.estado IN ('entregado','cobrado')) as total_cerrados,
            (SELECT COUNT(*) FROM presupuestos p WHERE p.vendedor_id=v.id
               AND p.estado IN ('aprobado','produccion','listo')) as total_activos,
            (SELECT COALESCE(SUM(p.precio),0) FROM presupuestos p WHERE p.vendedor_id=v.id
               AND p.estado IN ('aprobado','produccion','listo','entregado','cobrado')) as total_facturado,
            (SELECT COALESCE(SUM(co.monto),0) FROM cobros co
               WHERE co.presupuesto_id IN (
                 SELECT p.id FROM presupuestos p WHERE p.vendedor_id=v.id
               )) as total_cobrado
          FROM vendedores v WHERE v.activo=1 ORDER BY v.nombre`);
        return res.status(200).json({ ok: true, data: r.rows });
      }
      if (m === "POST") {
        const { nombre, email, telefono, notas } = req.body || {};
        if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
        const r = await db.execute({
          sql: "INSERT INTO vendedores (nombre,email,telefono,notas) VALUES (?,?,?,?)",
          args: [nombre.trim(), email||null, telefono||null, notas||null]
        });
        await logAction(db, user, "CREAR_VENDEDOR", "vendedor", Number(r.lastInsertRowid));
        return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
      }
      if (m === "PUT" && id) {
        const { nombre, email, telefono, notas } = req.body || {};
        if (!nombre) return res.status(400).json({ ok: false, error: "Nombre requerido" });
        await db.execute({
          sql: "UPDATE vendedores SET nombre=?,email=?,telefono=?,notas=? WHERE id=?",
          args: [nombre.trim(), email||null, telefono||null, notas||null, id]
        });
        await logAction(db, user, "EDITAR_VENDEDOR", "vendedor", id);
        return res.status(200).json({ ok: true });
      }
      if (m === "DELETE" && id) {
        await db.execute({ sql: "UPDATE vendedores SET activo=0 WHERE id=?", args: [id] });
        await logAction(db, user, "ELIMINAR_VENDEDOR", "vendedor", id);
        return res.status(200).json({ ok: true });
      }
    }

    // ───────────────────────── CAJA ─────────────────────────
    if (recurso === "caja") {
      await db.execute(`CREATE TABLE IF NOT EXISTS caja_movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL DEFAULT 'ingreso',
        concepto TEXT NOT NULL,
        monto REAL NOT NULL DEFAULT 0,
        moneda TEXT DEFAULT 'UYU',
        fecha TEXT NOT NULL,
        ref_tipo TEXT, ref_id INTEGER, notas TEXT,
        created_by INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      if (m === "GET") {
        const r = await db.execute("SELECT * FROM caja_movimientos ORDER BY fecha DESC, id DESC LIMIT 300");
        const saldo = r.rows.reduce((s,mv) => s + (mv.tipo==="ingreso" ? Number(mv.monto) : -Number(mv.monto)), 0);
        return res.status(200).json({ ok:true, data:r.rows, saldo:Math.round(saldo*100)/100 });
      }
      if (m === "POST") {
        const { tipo, concepto, monto, fecha, ref_tipo, ref_id, notas } = req.body||{};
        if (!concepto||!monto||!fecha) return res.status(400).json({ok:false,error:"Concepto, monto y fecha requeridos"});
        const r = await db.execute({
          sql:"INSERT INTO caja_movimientos (tipo,concepto,monto,fecha,ref_tipo,ref_id,notas,created_by) VALUES (?,?,?,?,?,?,?,?)",
          args:[tipo||"ingreso",concepto,Number(monto),fecha,ref_tipo||null,ref_id||null,notas||null,user.id]
        });
        await logAction(db,user,tipo==="egreso"?"CAJA_EGRESO":"CAJA_INGRESO","caja",Number(r.lastInsertRowid));
        return res.status(200).json({ok:true,data:{id:Number(r.lastInsertRowid)}});
      }
      if (m === "DELETE" && id) {
        await db.execute({sql:"DELETE FROM caja_movimientos WHERE id=?",args:[id]});
        await logAction(db,user,"CAJA_ELIMINAR","caja",Number(id));
        return res.status(200).json({ok:true});
      }
    }

    // ───────────────────────── ESTADO DE CUENTA ─────────────────────────
    if (recurso === "estado-cuenta") {
      if (m === "GET") {
        await db.execute(`CREATE TABLE IF NOT EXISTS caja_movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL DEFAULT 'ingreso', concepto TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0, moneda TEXT DEFAULT 'UYU', fecha TEXT NOT NULL, ref_tipo TEXT, ref_id INTEGER, notas TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
        const { desde, hasta } = req.query;
        const bf = (col) => {
          const p = []; const a = [];
          if (desde) { p.push(`${col} >= ?`); a.push(desde); }
          if (hasta) { p.push(`${col} <= ?`); a.push(hasta); }
          return { clause: p.length ? ' AND '+p.join(' AND ') : '', args: a };
        };
        const fc = bf('co.fecha'), fg = bf('g.fecha'), fr = bf("COALESCE(r.executed_at,r.fecha)"), fk = bf('cm.fecha');
        const [cobros, gastos, repartos, caja, gpRows] = await Promise.all([
          db.execute({sql:`SELECT co.id, co.monto, co.fecha, 'cobro' as tipo, COALESCE(p.pieza,'—') as descripcion, COALESCE(cl.nombre,p.cliente,'—') as ref FROM cobros co LEFT JOIN presupuestos p ON p.id=co.presupuesto_id LEFT JOIN clientes cl ON cl.id=co.cliente_id WHERE 1=1${fc.clause} ORDER BY co.fecha DESC, co.id DESC LIMIT 500`,args:fc.args}),
          db.execute({sql:`SELECT g.id, g.monto, g.fecha, 'gasto' as tipo, g.descripcion, g.categoria as ref, g.origen FROM gastos g WHERE 1=1${fg.clause} ORDER BY g.fecha DESC, g.id DESC LIMIT 500`,args:fg.args}),
          db.execute({sql:`SELECT r.id, r.monto, COALESCE(r.executed_at,r.fecha) as fecha, 'reparto' as tipo, r.descripcion, COALESCE(r.destinatario,'—') as ref FROM repartos r WHERE r.estado='ejecutado'${fr.clause} ORDER BY COALESCE(r.executed_at,r.fecha) DESC, r.id DESC LIMIT 500`,args:fr.args}),
          db.execute({sql:`SELECT cm.id, cm.monto, cm.fecha, cm.tipo, cm.concepto as descripcion, '' as ref FROM caja_movimientos cm WHERE 1=1${fk.clause} ORDER BY cm.fecha DESC, cm.id DESC LIMIT 500`,args:fk.args}),
          // Resumen de gastos personales por usuario (sin filtro de fecha — balance acumulado)
          db.execute(`SELECT g.pagado_por as usuario_id, COALESCE(u.nombre,'Usuario #'||g.pagado_por) as usuario_nombre, COALESCE(SUM(g.monto),0) as total, COUNT(*) as cantidad FROM gastos g LEFT JOIN usuarios u ON u.id=g.pagado_por WHERE g.origen='personal' AND g.pagado_por IS NOT NULL GROUP BY g.pagado_por, u.nombre ORDER BY u.nombre`)
        ]);
        const totalCobrado  = cobros.rows.reduce((s,r)=>s+Number(r.monto),0);
        const totalGastado  = gastos.rows.reduce((s,r)=>s+Number(r.monto),0);
        const totalRepartido= repartos.rows.reduce((s,r)=>s+Number(r.monto),0);
        const saldoCaja     = caja.rows.reduce((s,r)=>s+(r.tipo==='ingreso'?Number(r.monto):-Number(r.monto)),0);
        return res.status(200).json({ok:true, resumen:{totalCobrado,totalGastado,totalRepartido,saldoCaja}, cobros:cobros.rows, gastos:gastos.rows, repartos:repartos.rows, caja:caja.rows, gastos_personales:gpRows.rows});
      }
    }

    return res.status(400).json({ ok: false, error: "Recurso o método no soportado" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
