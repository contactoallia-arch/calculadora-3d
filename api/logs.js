import { getDB } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin"]);
  if (!user) return;

  // ── EXPLORADOR DE BASE DE DATOS (/api/database → /api/logs?recurso=database)
  if (req.query.recurso === "database") {
    if (req.method === "POST") {
      const { sql } = req.body || {};
      if (!sql) return res.status(400).json({ ok: false, error: "SQL requerido" });
      const sqlTrim = sql.trim().toUpperCase().replace(/\s+/g, " ");
      if (!sqlTrim.startsWith("SELECT") && !sqlTrim.startsWith("PRAGMA") && !sqlTrim.startsWith("WITH")) {
        return res.status(400).json({ ok: false, error: "Solo se permiten consultas SELECT, PRAGMA o WITH" });
      }
      try {
        const r = await db.execute({ sql: sql.trim(), args: [] });
        return res.status(200).json({ ok: true, data: r.rows, columns: r.columns, rowCount: r.rows.length });
      } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
      }
    }

    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Método no permitido" });

    const { table, page = "1", limit = "50", search, col } = req.query;

    if (!table) {
      const tables = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const result = [];
      for (const t of tables.rows) {
        let count = 0;
        try {
          const cnt = await db.execute({ sql: `SELECT COUNT(*) as c FROM "${t.name}"`, args: [] });
          count = Number(cnt.rows[0]?.c ?? 0);
        } catch {}
        result.push({ name: t.name, count });
      }
      return res.status(200).json({ ok: true, data: result });
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    const schema = await db.execute({ sql: `PRAGMA table_info("${table}")`, args: [] });
    const columns = schema.rows.map(c => ({ name: c.name, type: c.type }));

    const countArgs = [];
    let countSql = `SELECT COUNT(*) as c FROM "${table}"`;
    if (search && col) { countSql += ` WHERE CAST("${col}" AS TEXT) LIKE ?`; countArgs.push(`%${search}%`); }
    const countR = await db.execute({ sql: countSql, args: countArgs });
    const total = Number(countR.rows[0]?.c ?? 0);

    const dataArgs = [];
    let dataSql = `SELECT * FROM "${table}"`;
    if (search && col) { dataSql += ` WHERE CAST("${col}" AS TEXT) LIKE ?`; dataArgs.push(`%${search}%`); }
    dataSql += ` LIMIT ? OFFSET ?`;
    dataArgs.push(limitNum, offset);
    const dataR = await db.execute({ sql: dataSql, args: dataArgs });

    return res.status(200).json({
      ok: true, table, columns, data: dataR.rows, total,
      page: pageNum, limit: limitNum, pages: Math.max(1, Math.ceil(total / limitNum))
    });
  }

  // ── AUDIT LOG (/api/logs)
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Método no permitido" });

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
