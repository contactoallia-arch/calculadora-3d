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
        let sql = `SELECT i.*, p.nombre as proveedor_nombre FROM insumos i
          LEFT JOIN proveedores p ON p.id=i.proveedor_id WHERE i.activo=1`;
        const args = [];
        if (categoria) { sql += " AND i.categoria=?"; args.push(categoria); }
        sql += " ORDER BY i.categoria, i.nombre";
        const r = await db.execute({ sql, args });
        return res.status(200).json({ ok: true, data: r.rows });
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
        const r = await db.execute({
          sql: "INSERT INTO insumos (nombre,categoria,tipo,proveedor_id,precio,moneda,unidad,stock,notas) VALUES (?,?,?,?,?,?,?,?,?)",
          args: [nombre, categoria||"otros", tipo||null, proveedor_id||null, precio||0, moneda||"UYU", unidad||"kg", stock||0, notas||null]
        });
        const nid = Number(r.lastInsertRowid);
        await logAction(db, user, "CREAR_INSUMO", "insumo", nid);
        return res.status(200).json({ ok: true, data: { id: nid } });
      }
      if (m === "PUT" && id) {
        if (req.query.action === "add-stock") {
          const { qty, precio } = req.body || {};
          await db.execute({
            sql: "UPDATE insumos SET stock=stock+?, precio=COALESCE(?,precio) WHERE id=?",
            args: [Number(qty)||0, precio||null, id]
          });
          await logAction(db, user, "STOCK_INSUMO", "insumo", id);
          return res.status(200).json({ ok: true });
        }
        const { nombre, categoria, tipo, proveedor_id, precio, moneda, unidad, stock, stock_min, notas } = req.body || {};
        await db.execute({
          sql: "UPDATE insumos SET nombre=?,categoria=?,tipo=?,proveedor_id=?,precio=?,moneda=?,unidad=?,stock=?,stock_min=?,notas=? WHERE id=?",
          args: [nombre, categoria||"otros", tipo||null, proveedor_id||null, precio||0, moneda||"UYU", unidad||"kg", stock||0, stock_min!=null?Number(stock_min):null, notas||null, id]
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
            (SELECT COALESCE(SUM(i.precio*i.stock),0) FROM insumos i WHERE i.proveedor_id=pr.id AND i.activo=1) as total_comprado
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
          p.pieza as presupuesto_pieza, c.nombre as cliente_nombre
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
        return res.status(200).json({ ok: true, data: r.rows });
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
        const { descripcion, destinatario, monto, fecha, notas } = req.body||{};
        if (!descripcion||!monto) return res.status(400).json({ok:false,error:"Descripción y monto requeridos"});
        const r = await db.execute({ sql:"INSERT INTO repartos (descripcion,destinatario,monto,fecha,notas,estado,created_by) VALUES (?,?,?,?,?,'pendiente',?)", args:[descripcion,destinatario||null,Number(monto),fecha||null,notas||null,user.id] });
        await logAction(db,user,"CREAR_REPARTO","reparto",Number(r.lastInsertRowid));
        return res.status(200).json({ok:true,data:{id:Number(r.lastInsertRowid)}});
      }
      if (m === "PUT" && id) {
        const { accion } = req.body||{};
        const r = await db.execute({sql:"SELECT estado FROM repartos WHERE id=?",args:[id]});
        if (!r.rows[0]) return res.status(404).json({ok:false,error:"No encontrado"});
        if (r.rows[0].estado==="ejecutado") return res.status(400).json({ok:false,error:"Ya fue ejecutado"});
        const nuevo = accion==="ejecutar"?"ejecutado":"cancelado";
        await db.execute({sql:"UPDATE repartos SET estado=?,executed_at=? WHERE id=?",args:[nuevo,nuevo==="ejecutado"?new Date().toISOString().slice(0,10):null,id]});
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

    return res.status(400).json({ ok: false, error: "Recurso o método no soportado" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
