import { getDB } from "../../_lib/db.js";
import { requireAuth } from "../../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const id = req.query.id;
  const r = await db.execute({
    sql: "SELECT * FROM presupuesto_estados WHERE presupuesto_id=? ORDER BY id DESC",
    args: [id]
  });
  return res.status(200).json({ ok: true, data: r.rows });
}
