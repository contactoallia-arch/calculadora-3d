import { getDB } from "../_lib/db.js";
import { requireAuth, logAction } from "../_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin", "operador"]);
  if (!user) return;

  const ahora = new Date();
  const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}`;

  // Verificar si ya se generaron este mes
  const cfg = await db.execute({ sql: "SELECT valor FROM configuracion WHERE clave='gastos_fijos_mes'", args: [] });
  if (cfg.rows[0]?.valor === mesActual) {
    return res.status(200).json({ ok: false, error: `Los gastos fijos de ${mesActual} ya fueron generados` });
  }

  const fijos = await db.execute("SELECT * FROM gastos_fijos WHERE activo=1");
  let generados = 0;
  for (const gf of fijos.rows) {
    const dia = String(gf.dia_del_mes).padStart(2, "0");
    const fecha = `${dia}/${String(ahora.getMonth()+1).padStart(2,"0")}/${ahora.getFullYear()}`;
    await db.execute({
      sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,fecha,tipo,recurrente,gasto_fijo_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [gf.categoria, gf.nombre, gf.monto, gf.moneda, fecha, "fijo_mensual", 1, gf.id, user.id]
    });
    generados++;
  }

  await db.execute({ sql: "INSERT OR REPLACE INTO configuracion (clave,valor) VALUES (?,?)", args: ["gastos_fijos_mes", mesActual] });
  await logAction(db, user, "GENERAR_GASTOS_FIJOS", "gasto", null, { mes: mesActual, cantidad: generados });

  return res.status(200).json({ ok: true, data: { generados, mes: mesActual } });
}
