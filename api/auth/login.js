import { getDB } from "../_lib/db.js";
import { signToken, logAction } from "../_lib/auth.js";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const db = getDB();
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "Email y contraseña requeridos" });

  const r = await db.execute({ sql: "SELECT * FROM usuarios WHERE email=? AND activo=1", args: [email.toLowerCase().trim()] });
  const user = r.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ ok: false, error: "Email o contraseña incorrectos" });
  }

  const token = signToken({ id: user.id, email: user.email, rol: user.rol });
  await db.execute({ sql: "UPDATE usuarios SET last_login=datetime('now') WHERE id=?", args: [user.id] });
  await logAction(db, user, "LOGIN_OK", "usuario", user.id, null, req.headers["x-forwarded-for"]);

  return res.status(200).json({
    ok: true,
    token,
    user: { id: Number(user.id), nombre: user.nombre, email: user.email, rol: user.rol }
  });
}
