import { getDB } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  if (req.method === "GET") {
    const r = await db.execute("SELECT clave, valor FROM configuracion");
    const cfg = {};
    r.rows.forEach(row => { cfg[row.clave] = row.valor; });
    return res.status(200).json({ ok: true, data: cfg });
  }

  if (req.method === "PUT") {
    if (user.rol !== "admin") return res.status(403).json({ ok: false, error: "Sin permiso" });
    const updates = req.body || {};
    for (const [k, v] of Object.entries(updates)) {
      await db.execute({ sql: "INSERT OR REPLACE INTO configuracion (clave,valor) VALUES (?,?)", args: [k, String(v)] });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
