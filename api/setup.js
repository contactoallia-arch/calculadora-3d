// GET /api/setup — crea la tabla si no existe (llamar una sola vez tras el deploy)
import { createClient } from "@libsql/client";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  const db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });
  await db.execute(`
    CREATE TABLE IF NOT EXISTS presupuestos (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      pieza    TEXT    NOT NULL DEFAULT '',
      cliente  TEXT    NOT NULL DEFAULT '',
      mat      TEXT    NOT NULL DEFAULT 'PLA',
      qty      INTEGER NOT NULL DEFAULT 1,
      precio   REAL    NOT NULL DEFAULT 0,
      margen   INTEGER NOT NULL DEFAULT 50,
      fecha    TEXT    NOT NULL DEFAULT '',
      snap     TEXT,
      created_at TEXT  DEFAULT (datetime('now'))
    )
  `);
  return res.status(200).json({ ok: true, message: "Tabla lista." });
}
