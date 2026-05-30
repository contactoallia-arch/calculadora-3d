import { getDB } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin"]);
  if (!user) return;

  const { usuario, accion, desde, hasta } = req.query || {};
  let sql = "SELECT * FROM audit_log WHERE 1=1";
  const args = [];
  if (usuario) { sql += " AND usuario_nombre LIKE ?"; args.push(`%${usuario}%`); }
  if (accion) { sql += " AND accion LIKE ?"; args.push(`%${accion}%`); }
  if (desde) { sql += " AND created_at >= ?"; args.push(desde); }
  if (hasta) { sql += " AND created_at <= ?"; args.push(hasta); }
  sql += " ORDER BY id DESC LIMIT 500";

  const r = await db.execute({ sql, args });
  return res.status(200).json({ ok: true, data: r.rows });
}
