import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin"]);
  if (!user) return;

  if (req.method === "GET") {
    const r = await db.execute("SELECT id,nombre,email,rol,activo,created_at,last_login FROM usuarios ORDER BY id");
    return res.status(200).json({ ok: true, data: r.rows });
  }

  if (req.method === "POST") {
    const { nombre, email, password, rol } = req.body || {};
    if (!nombre || !email || !password) return res.status(400).json({ ok: false, error: "Nombre, email y contraseña requeridos" });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.execute({
      sql: "INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)",
      args: [nombre, email.toLowerCase().trim(), hash, rol || "operador"]
    });
    await logAction(db, user, "CREAR_USUARIO", "usuario", Number(r.lastInsertRowid));
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
