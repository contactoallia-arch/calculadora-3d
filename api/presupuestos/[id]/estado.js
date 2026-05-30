import { getDB } from "../../_lib/db.js";
import { requireAuth, logAction } from "../../_lib/auth.js";

const FLUJO = {
  borrador:   ["enviado", "cancelado"],
  enviado:    ["aprobado", "rechazado", "cancelado"],
  aprobado:   ["produccion", "cancelado"],
  produccion: ["listo", "cancelado"],
  listo:      ["entregado", "cancelado"],
  entregado:  ["cobrado", "cancelado"],
  cobrado:    [],
  rechazado:  [],
  cancelado:  []
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const db = getDB();
  const user = await requireAuth(req, res, db, ["admin", "operador"]);
  if (!user) return;

  const id = req.query.id;
  const { estado_nuevo, nota } = req.body || {};

  const r = await db.execute({ sql: "SELECT estado,pieza,snap,precio,margen FROM presupuestos WHERE id=?", args: [id] });
  const pres = r.rows[0];
  if (!pres) return res.status(404).json({ ok: false, error: "Presupuesto no encontrado" });

  const estado_actual = pres.estado || "borrador";
  const permitidos = FLUJO[estado_actual] || [];
  if (!permitidos.includes(estado_nuevo)) {
    return res.status(400).json({ ok: false, error: `No se puede pasar de '${estado_actual}' a '${estado_nuevo}'` });
  }

  await db.execute({
    sql: "UPDATE presupuestos SET estado=?,updated_at=datetime('now'),updated_by=? WHERE id=?",
    args: [estado_nuevo, user.id, id]
  });

  await db.execute({
    sql: "INSERT INTO presupuesto_estados (presupuesto_id,estado_anterior,estado_nuevo,nota,usuario_id,usuario_nombre) VALUES (?,?,?,?,?,?)",
    args: [id, estado_actual, estado_nuevo, nota||null, user.id, user.nombre]
  });

  // Gasto automático al iniciar producción
  if (estado_nuevo === "produccion" && pres.snap) {
    try {
      const snap = JSON.parse(pres.snap);
      const costos = [
        { cat: "filamento",    monto: snap._matC,   desc: "Material" },
        { cat: "electricidad", monto: snap._elecC,  desc: "Electricidad" },
        { cat: "maquinaria",   monto: snap._deprC,  desc: "Depreciación impresora" },
        { cat: "otros",        monto: snap._laborC, desc: "Mano de obra" }
      ];
      const fecha = new Date().toLocaleDateString("es-UY");
      for (const c of costos) {
        if (c.monto > 0) {
          await db.execute({
            sql: "INSERT INTO gastos (categoria,descripcion,monto,moneda,fecha,tipo,presupuesto_id,created_by) VALUES (?,?,?,?,?,?,?,?)",
            args: [c.cat, `${c.desc} — Presupuesto #${id}: ${pres.pieza}`, c.monto, "UYU", fecha, "produccion_automatico", id, user.id]
          });
        }
      }
    } catch {}
  }

  await logAction(db, user, "CAMBIAR_ESTADO", "presupuesto", id, { estado_actual, estado_nuevo, nota });
  return res.status(200).json({ ok: true, data: { estado: estado_nuevo } });
}
