import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "artelab-jwt-secret-2025";

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: "8h" });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

export function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

export async function requireAuth(req, res, db, roles = null) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "No autorizado" });
    return null;
  }
  let payload;
  try { payload = verifyToken(token); } catch {
    res.status(401).json({ ok: false, error: "Token inválido o expirado" });
    return null;
  }
  const bl = await db.execute({ sql: "SELECT 1 FROM token_blacklist WHERE token=?", args: [token] });
  if (bl.rows.length > 0) {
    res.status(401).json({ ok: false, error: "Sesión cerrada" });
    return null;
  }
  // Resiliente: si la columna vendedor_id aún no existe (setup no corrió tras deploy), usar fallback
  let ur;
  try {
    ur = await db.execute({ sql: "SELECT id, nombre, email, rol, activo, vendedor_id FROM usuarios WHERE id=?", args: [payload.id] });
  } catch {
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN vendedor_id INTEGER"); } catch {}
    ur = await db.execute({ sql: "SELECT id, nombre, email, rol, activo FROM usuarios WHERE id=?", args: [payload.id] });
  }
  const user = ur.rows[0];
  if (!user || !user.activo) {
    res.status(401).json({ ok: false, error: "Usuario inactivo o no encontrado" });
    return null;
  }
  if (roles && !roles.includes(user.rol)) {
    res.status(403).json({ ok: false, error: "Sin permiso para esta acción" });
    return null;
  }
  return { ...user };
}

export async function logAction(db, usuario, accion, entidad, entidad_id, detalle = null, ip = null) {
  try {
    await db.execute({
      sql: `INSERT INTO audit_log (usuario_id, usuario_nombre, accion, entidad, entidad_id, detalle, ip) VALUES (?,?,?,?,?,?,?)`,
      args: [usuario.id, usuario.nombre, accion, entidad, entidad_id || null, detalle ? JSON.stringify(detalle) : null, ip || null]
    });
  } catch {}
}
