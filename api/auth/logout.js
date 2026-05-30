import { getDB } from "../_lib/db.js";
import { getToken, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const token = getToken(req);
  if (token) {
    // Blacklist token por 8h (tiempo de vida del token)
    const exp = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    try {
      await db.execute({ sql: "INSERT OR IGNORE INTO token_blacklist (token,expires_at) VALUES (?,?)", args: [token, exp] });
    } catch {}
  }

  return res.status(200).json({ ok: true });
}
