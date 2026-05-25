// Vercel Serverless Function — GET/POST/PUT/DELETE /api/presupuestos
import { createClient } from "@libsql/client";

function getDB() {
  return createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
}

async function ensureSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS presupuestos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      numero     INTEGER,
      pieza      TEXT NOT NULL DEFAULT '',
      cliente    TEXT NOT NULL DEFAULT '',
      mat        TEXT NOT NULL DEFAULT 'PLA',
      qty        INTEGER NOT NULL DEFAULT 1,
      precio     REAL NOT NULL DEFAULT 0,
      margen     INTEGER NOT NULL DEFAULT 50,
      fecha      TEXT NOT NULL DEFAULT '',
      snap       TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try { await db.execute("ALTER TABLE presupuestos ADD COLUMN numero INTEGER"); } catch {}
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  await ensureSchema(db);

  // GET — listar
  if (req.method === "GET") {
    const result = await db.execute(
      "SELECT id, COALESCE(numero, id) as numero, pieza, cliente, mat, qty, precio, margen, fecha, snap FROM presupuestos ORDER BY id DESC LIMIT 200"
    );
    const rows = result.rows.map(r => ({ ...r, snap: r.snap ? JSON.parse(r.snap) : null }));
    return res.status(200).json({ ok: true, data: rows });
  }

  // POST — crear nuevo
  if (req.method === "POST") {
    const { pieza, cliente, mat, qty, precio, margen, fecha, snap } = req.body;
    if (!precio || precio <= 0) return res.status(400).json({ ok: false, error: "Precio inválido" });
    const maxRes = await db.execute("SELECT MAX(COALESCE(numero, id)) as mx FROM presupuestos");
    const nextNum = (Number(maxRes.rows[0]?.mx) || 0) + 1;
    const result = await db.execute({
      sql: `INSERT INTO presupuestos (numero, pieza, cliente, mat, qty, precio, margen, fecha, snap) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [nextNum, pieza||"Sin nombre", cliente||"—", mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null],
    });
    return res.status(200).json({ ok: true, data: { id: Number(result.lastInsertRowid), numero: nextNum } });
  }

  // PUT — actualizar existente
  if (req.method === "PUT") {
    const { id, numero, pieza, cliente, mat, qty, precio, margen, fecha, snap } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "ID requerido" });
    await db.execute({
      sql: `UPDATE presupuestos SET numero=?, pieza=?, cliente=?, mat=?, qty=?, precio=?, margen=?, fecha=?, snap=? WHERE id=?`,
      args: [numero, pieza||"Sin nombre", cliente||"—", mat||"", qty||1, precio, margen||0, fecha||new Date().toLocaleDateString("es-UY"), snap?JSON.stringify(snap):null, id],
    });
    return res.status(200).json({ ok: true });
  }

  // DELETE — borrar todo
  if (req.method === "DELETE") {
    await db.execute("DELETE FROM presupuestos");
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
