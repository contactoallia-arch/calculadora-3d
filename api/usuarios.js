import { getDB } from "./_lib/db.js";
import { requireAuth, logAction } from "./_lib/auth.js";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  // Sin restricción de rol aquí — cada operación verifica por separado
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const id = req.query.id;

  if (id) {
    const isSelf = Number(id) === Number(user.id);
    const isAdmin = user.rol === "admin";

    if (req.method === "GET") {
      if (!isAdmin && !isSelf) return res.status(403).json({ ok: false, error: "Sin permiso" });
      const r = await db.execute({ sql: "SELECT id,nombre,email,telefono,rol,activo,created_at,last_login,vendedor_id,banco,cuenta_numero,cuenta_sucursal,cuenta_moneda,cuenta_tipo FROM usuarios WHERE id=?", args: [id] });
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
      return res.status(200).json({ ok: true, data: r.rows[0] });
    }

    if (req.method === "PUT") {
      if (!isAdmin && !isSelf) return res.status(403).json({ ok: false, error: "Sin permiso" });

      const body = req.body || {};
      const { nombre, email, telefono, rol, activo, password } = body;

      // Usuarios no-admin solo pueden editar su propio nombre, email, telefono, datos bancarios y contraseña
      const newRol    = isAdmin ? (rol    ?? user.rol) : user.rol;
      const newActivo = isAdmin ? (activo !== undefined ? activo : 1) : 1;
      // Vínculo a ficha de vendedor: solo lo asigna un admin
      const curR = await db.execute({ sql: "SELECT banco,cuenta_numero,cuenta_sucursal,cuenta_moneda,cuenta_tipo,vendedor_id FROM usuarios WHERE id=?", args: [id] });
      const cur = curR.rows[0] || {};
      const newVendId = isAdmin ? (body.vendedor_id !== undefined ? (body.vendedor_id || null) : (cur.vendedor_id ?? null)) : (cur.vendedor_id ?? null);

      // Datos bancarios: solo se sobrescriben si vienen en el body (el form de admin no los envía)
      const bk = (k, def) => (body[k] !== undefined ? (body[k] || null) : (cur[k] ?? def ?? null));
      const banco = bk("banco"), cuentaNum = bk("cuenta_numero"), cuentaSuc = bk("cuenta_sucursal");
      const cuentaMon = bk("cuenta_moneda", "UYU"), cuentaTipo = bk("cuenta_tipo", "caja_ahorro");

      let sql  = "UPDATE usuarios SET nombre=?,email=?,telefono=?,rol=?,activo=?,vendedor_id=?,banco=?,cuenta_numero=?,cuenta_sucursal=?,cuenta_moneda=?,cuenta_tipo=? WHERE id=?";
      let args = [nombre, email?.toLowerCase().trim(), telefono||null, newRol, newActivo, newVendId, banco, cuentaNum, cuentaSuc, cuentaMon, cuentaTipo, id];
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        sql  = "UPDATE usuarios SET nombre=?,email=?,telefono=?,rol=?,activo=?,vendedor_id=?,banco=?,cuenta_numero=?,cuenta_sucursal=?,cuenta_moneda=?,cuenta_tipo=?,password_hash=? WHERE id=?";
        args = [nombre, email?.toLowerCase().trim(), telefono||null, newRol, newActivo, newVendId, banco, cuentaNum, cuentaSuc, cuentaMon, cuentaTipo, hash, id];
      }
      await db.execute({ sql, args });
      await logAction(db, user, isSelf ? "EDITAR_PERFIL" : "EDITAR_USUARIO", "usuario", id);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      if (!isAdmin) return res.status(403).json({ ok: false, error: "Sin permiso" });
      if (isSelf)   return res.status(400).json({ ok: false, error: "No podés eliminar tu propio usuario" });
      const tgt = await db.execute({ sql: "SELECT nombre,email,rol FROM usuarios WHERE id=?", args: [id] });
      const t = tgt.rows[0];
      if (!t) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });
      if (t.rol === "admin") {
        const admins = await db.execute("SELECT COUNT(*) as c FROM usuarios WHERE rol='admin' AND activo=1");
        if (Number(admins.rows[0].c) <= 1)
          return res.status(400).json({ ok: false, error: "No podés eliminar el último administrador" });
      }
      await db.execute({ sql: "DELETE FROM usuarios WHERE id=?", args: [id] });
      await logAction(db, user, "ELIMINAR_USUARIO", "usuario", id, { nombre: t.nombre, email: t.email, rol: t.rol });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  // Lista y creación — solo admin
  if (!["GET","POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "Método no permitido" });
  if (user.rol !== "admin") return res.status(403).json({ ok: false, error: "Sin permiso" });

  if (req.method === "GET") {
    const r = await db.execute("SELECT id,nombre,email,telefono,rol,activo,created_at,last_login,vendedor_id FROM usuarios ORDER BY id");
    return res.status(200).json({ ok: true, data: r.rows });
  }
  if (req.method === "POST") {
    const { nombre, email, password, rol, vendedor_id } = req.body || {};
    if (!nombre || !email || !password) return res.status(400).json({ ok: false, error: "Nombre, email y contraseña requeridos" });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.execute({ sql: "INSERT INTO usuarios (nombre,email,password_hash,rol,vendedor_id) VALUES (?,?,?,?,?)", args: [nombre, email.toLowerCase().trim(), hash, rol || "operador", (rol === "vendedor" ? (vendedor_id||null) : null)] });
    await logAction(db, user, "CREAR_USUARIO", "usuario", Number(r.lastInsertRowid));
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }
}
