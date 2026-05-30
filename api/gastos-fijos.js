import { getDB } from "./_lib/db.js";
import { requireAuth, logAction } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const { id, action } = req.query;

  // generar-mes
  if (action === "generar-mes") {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
    const user2 = await requireAuth(req, res, db, ["admin", "operador"]);
    if (!user2) return;
    const ahora = new Date();
    const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}`;
    const cfg = await db.execute({ sql: "SELECT valor FROM configuracion WHERE clave='gastos_fijos_mes'", args: [] });
    if (cfg.rows[0]?.valor === mesActual) {
      return res.status(200).json({ ok: false, error: `Los gastos fijos de ${mesActual} ya fueron generados` });
    }
    const fijos = await db.execute("SELECT * FROM gastos_fijos WHERE activo=1");
    let generados = 0;
    for (const gf of fijos.rows) {
      const dia = String(gf.dia_del_mes).padStart(2, "0");
      const fecha = `${dia}/${String(ahora.getMonth()+1).padStart(2,"0")}/${ahora.getFullYear()}`;
      await db.execute({ sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,fecha,tipo,recurrente,gasto_fijo_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)", args: [gf.categoria, gf.nombre, gf.monto, gf.moneda, fecha, "fijo_mensual", 1, gf.id, user2.id] });
      generados++;
    }
    await db.execute({ sql: "INSERT OR REPLACE INTO configuracion (clave,valor) VALUES (?,?)", args: ["gastos_fijos_mes", mesActual] });
    await logAction(db, user2, "GENERAR_GASTOS_FIJOS", "gasto", null, { mes: mesActual, cantidad: generados });
    return res.status(200).json({ ok: true, data: { generados, mes: mesActual } });
  }

  if (id) {
    const user2 = await requireAuth(req, res, db, ["admin", "operador"]);
    if (!user2) return;
    if (req.method === "PUT") {
      const { nombre, categoria, monto, moneda, dia_del_mes, activo } = req.body || {};
      await db.execute({ sql: "UPDATE gastos_fijos SET nombre=?,categoria=?,monto=?,moneda=?,dia_del_mes=?,activo=? WHERE id=?", args: [nombre, categoria||"otros", monto, moneda||"UYU", dia_del_mes||1, activo?1:0, id] });
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      await db.execute({ sql: "DELETE FROM gastos_fijos WHERE id=?", args: [id] });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  if (req.method === "GET") {
    const r = await db.execute("SELECT * FROM gastos_fijos ORDER BY dia_del_mes,nombre");
    return res.status(200).json({ ok: true, data: r.rows });
  }
  if (req.method === "POST") {
    const { nombre, categoria, monto, moneda, dia_del_mes } = req.body || {};
    if (!nombre || !monto) return res.status(400).json({ ok: false, error: "Nombre y monto requeridos" });
    const r = await db.execute({ sql: "INSERT INTO gastos_fijos (nombre,categoria,monto,moneda,dia_del_mes) VALUES (?,?,?,?,?)", args: [nombre, categoria||"otros", monto, moneda||"UYU", dia_del_mes||1] });
    return res.status(200).json({ ok: true, data: { id: Number(r.lastInsertRowid) } });
  }

  return res.status(405).json({ ok: false, error: "Método no permitido" });
}
