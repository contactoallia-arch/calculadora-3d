// Vercel Serverless Function — DELETE /api/presupuestos/:id
import { createClient } from "@libsql/client";

function getDB() {
  return createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { id } = req.query;

  if (req.method === "DELETE") {
    const db = getDB();
    await db.execute({ sql: "DELETE FROM presupuestos WHERE id = ?", args: [id] });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
