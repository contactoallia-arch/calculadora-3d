import { getDB } from "./_lib/db.js";
import { signToken, logAction, getToken, requireAuth } from "./_lib/auth.js";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const db = getDB();

  if (action === "login") {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: "Email y contraseña requeridos" });
    const loginVal = email.toLowerCase().trim();
    const r = await db.execute({
      sql: "SELECT * FROM usuarios WHERE (LOWER(email)=? OR LOWER(nombre)=?) AND activo=1",
      args: [loginVal, loginVal]
    });
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ ok: false, error: "Email o contraseña incorrectos" });
    }
    const token = signToken({ id: user.id, email: user.email, rol: user.rol });
    await db.execute({ sql: "UPDATE usuarios SET last_login=datetime('now') WHERE id=?", args: [user.id] });
    await logAction(db, user, "LOGIN_OK", "usuario", user.id, null, req.headers["x-forwarded-for"]);
    return res.status(200).json({ ok: true, token, user: { id: Number(user.id), nombre: user.nombre, email: user.email, rol: user.rol } });
  }

  if (action === "logout") {
    const token = getToken(req);
    if (token) {
      const exp = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      try { await db.execute({ sql: "INSERT OR IGNORE INTO token_blacklist (token,expires_at) VALUES (?,?)", args: [token, exp] }); } catch {}
    }
    return res.status(200).json({ ok: true });
  }

  if (action === "me") {
    const user = await requireAuth(req, res, db);
    if (!user) return;
    return res.status(200).json({ ok: true, user });
  }

  return res.status(400).json({ ok: false, error: "Acción no reconocida" });
}
