// Vercel Serverless Function — GET /api/presupuestos y POST /api/presupuestos
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

  const db = getDB();

  // GET — listar presupuestos
  if (req.method === "GET") {
    const result = await db.execute(
      "SELECT * FROM presupuestos ORDER BY id DESC LIMIT 200"
    );
    const rows = result.rows.map((r) => ({
      ...r,
      snap: r.snap ? JSON.parse(r.snap) : null,
    }));
    return res.status(200).json({ ok: true, data: rows });
  }

  // POST — guardar presupuesto
  if (req.method === "POST") {
    const { pieza, cliente, mat, qty, precio, margen, fecha, snap } = req.body;
    if (!precio || precio <= 0)
      return res.status(400).json({ ok: false, error: "Precio inválido" });

    const result = await db.execute({
      sql: `INSERT INTO presupuestos (pieza, cliente, mat, qty, precio, margen, fecha, snap)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        pieza || "Sin nombre",
        cliente || "—",
        mat || "",
        qty || 1,
        precio,
        margen || 0,
        fecha || new Date().toLocaleDateString("es-UY"),
        snap ? JSON.stringify(snap) : null,
      ],
    });
    return res.status(200).json({ ok: true, data: { id: Number(result.lastInsertRowid) } });
  }

  // DELETE — borrar todos los presupuestos
  if (req.method === "DELETE") {
    await db.execute("DELETE FROM presupuestos");
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
