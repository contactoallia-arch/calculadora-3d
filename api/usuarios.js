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
      const r = await db.execute({ sql: "SELECT id,nombre,email,telefono,rol,activo,created_at,last_login FROM usuarios WHERE id=?", args: [id] });
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "No encontrado" });
      return res.status(200).json({ ok: true, data: r.rows[0] });
    }

    if (req.method === "PUT") {
      if (!isAdmin && !isSelf) return res.status(403).json({ ok: false, error: "Sin permiso" });

      const { nombre, email, telefono, rol, activo, password } = req.body || {};

      // Usuarios no-admin solo pueden editar su propio nombre, email, telefono y contraseña
      const newRol    = isAdmin ? (rol    ?? user.rol) : user.rol;
      const newActivo = isAdmin ? (activo !== undefined ? activo : 1) : 1;

      let sql  = "UPDATE usuarios SET nombre=?,email=?,telefono=?,rol=?,activo=? WHERE id=?";
      let args = [nombre, email?.toLowerCase().trim(), telefono||null, newRol, newActivo, id];
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        sql  = "UPDATE usuarios SET nombre=?,email=?,telefono=?,rol=?,activo=?,password_hash=? WHERE id=?";
        args = [nombre, email?.toLowerCase().trim(), telefono||null, newRol, newActivo, hash, id];
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
    const r = await db.execute("SELECT id,nombre,email,telefono,rol,activo,created_at,last_login FROM usuarios ORDER BY id");
    return res.status(200).json({ ok: true, data: r.rows });
  }
  if (req.method === "POST") {
    const { nombre, email, password, rol } = req.body || {};
    if (!nombre || !email || !password) return res.status(400).json({ ok: false, error: "Nombre, email y contraseña requeridos" });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.execute({ sql: "INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)", args: [nombre, email.toLowerCase().trim(), hash, rol || "operador"] });
    await logAction(db, user, "CREAR_USUARIO", "usuario", Number(r.lastInsertRowid));
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }
}
