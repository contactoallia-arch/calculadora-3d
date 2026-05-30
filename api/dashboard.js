import { getDB } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();
  const user = await requireAuth(req, res, db);
  if (!user) return;

  const ahora = new Date();
  const mes = req.query.mes || `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}`;
  // mes en formato YYYY-MM, convertir a parte de fecha local (dd/mm/yyyy contiene el mes)
  const [anio, mm] = mes.split("-");
  const mesPattern = `%/${mm}/${anio}%`;
  // También soportar formato ISO en campo fecha
  const mesPatternISO = `${anio}-${mm}%`;

  // KPIs del mes
  const [facturadoR, cobradoR, gastosR, activosR] = await Promise.all([
    db.execute({
      sql: `SELECT COALESCE(SUM(precio),0) as total, moneda FROM presupuestos
            WHERE estado IN ('entregado','cobrado') AND (fecha LIKE ? OR fecha LIKE ?)
            GROUP BY moneda`,
      args: [mesPattern, mesPatternISO]
    }),
    db.execute({
      sql: `SELECT COALESCE(SUM(monto),0) as total, moneda FROM cobros
            WHERE fecha LIKE ? OR fecha LIKE ? GROUP BY moneda`,
      args: [mesPattern, mesPatternISO]
    }),
    db.execute({
      sql: `SELECT COALESCE(SUM(monto),0) as total FROM gastos WHERE fecha LIKE ? OR fecha LIKE ?`,
      args: [mesPattern, mesPatternISO]
    }),
    db.execute("SELECT COUNT(*) as cnt FROM presupuestos WHERE estado IN ('produccion','listo')"),
  ]);

  const facturadoUYU = facturadoR.rows.find(r=>r.moneda==="UYU")?.total || 0;
  const facturadoUSD = facturadoR.rows.find(r=>r.moneda==="USD")?.total || 0;
  const cobradoUYU = cobradoR.rows.find(r=>r.moneda==="UYU")?.total || 0;
  const cobradoUSD = cobradoR.rows.find(r=>r.moneda==="USD")?.total || 0;
  const gastosMes = Number(gastosR.rows[0]?.total || 0);
  const presActivos = Number(activosR.rows[0]?.cnt || 0);

  // Presupuestos por estado (mes)
  const estadosR = await db.execute({
    sql: `SELECT estado, COUNT(*) as cnt FROM presupuestos
          WHERE fecha LIKE ? OR fecha LIKE ? GROUP BY estado`,
    args: [mesPattern, mesPatternISO]
  });

  // Gastos por categoría (mes)
  const gastosCatR = await db.execute({
    sql: `SELECT categoria, COALESCE(SUM(monto),0) as total FROM gastos
          WHERE fecha LIKE ? OR fecha LIKE ? GROUP BY categoria ORDER BY total DESC`,
    args: [mesPattern, mesPatternISO]
  });

  // Serie mensual últimos 12 meses
  const serie = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth()-i, 1);
    const my = d.getFullYear();
    const mm2 = String(d.getMonth()+1).padStart(2,"0");
    const pat = `%/${mm2}/${my}%`;
    const patISO = `${my}-${mm2}%`;
    const [fR, cR, gR] = await Promise.all([
      db.execute({ sql: `SELECT COALESCE(SUM(precio),0) as t FROM presupuestos WHERE estado IN ('entregado','cobrado') AND (fecha LIKE ? OR fecha LIKE ?)`, args: [pat, patISO] }),
      db.execute({ sql: `SELECT COALESCE(SUM(monto),0) as t FROM cobros WHERE fecha LIKE ? OR fecha LIKE ?`, args: [pat, patISO] }),
      db.execute({ sql: `SELECT COALESCE(SUM(monto),0) as t FROM gastos WHERE fecha LIKE ? OR fecha LIKE ?`, args: [pat, patISO] })
    ]);
    serie.push({ mes: `${mm2}/${my}`, facturado: Number(fR.rows[0]?.t||0), cobrado: Number(cR.rows[0]?.t||0), gastos: Number(gR.rows[0]?.t||0) });
  }

  // Top 5 clientes
  const topClientesR = await db.execute(`
    SELECT COALESCE(c.nombre, p.cliente) as nombre, COALESCE(SUM(p.precio),0) as total
    FROM presupuestos p LEFT JOIN clientes c ON c.id=p.cliente_id
    WHERE p.estado IN ('entregado','cobrado')
    GROUP BY COALESCE(c.nombre, p.cliente) ORDER BY total DESC LIMIT 5
  `);

  // Últimos presupuestos y cobros pendientes
  const ultimosR = await db.execute("SELECT id,COALESCE(numero,id) as numero,pieza,cliente,estado,precio,moneda,fecha FROM presupuestos ORDER BY id DESC LIMIT 8");
  const pendientesR = await db.execute(`
    SELECT p.id, COALESCE(p.numero,p.id) as numero, p.pieza, p.cliente, p.precio, p.moneda, p.fecha
    FROM presupuestos p WHERE p.estado='entregado'
    AND (SELECT COALESCE(SUM(monto),0) FROM cobros WHERE presupuesto_id=p.id) < p.precio
    ORDER BY p.fecha ASC LIMIT 10
  `);
  const listosR = await db.execute("SELECT id,COALESCE(numero,id) as numero,pieza,cliente,precio,moneda,fecha_entrega,fecha FROM presupuestos WHERE estado='listo' ORDER BY fecha_entrega ASC LIMIT 5");

  // Métricas de conversión (todos los tiempos)
  const funnelR = await db.execute(`
    SELECT estado, COUNT(*) as cnt, COALESCE(SUM(precio),0) as valor
    FROM presupuestos GROUP BY estado
  `);
  const funnel = {};
  funnelR.rows.forEach(r => { funnel[r.estado] = { cnt: Number(r.cnt), valor: Number(r.valor) }; });

  const totalEnviados = (funnel.enviado?.cnt||0) + (funnel.aprobado?.cnt||0) + (funnel.produccion?.cnt||0) + (funnel.listo?.cnt||0) + (funnel.entregado?.cnt||0) + (funnel.cobrado?.cnt||0);
  const totalAprobados = (funnel.aprobado?.cnt||0) + (funnel.produccion?.cnt||0) + (funnel.listo?.cnt||0) + (funnel.entregado?.cnt||0) + (funnel.cobrado?.cnt||0);
  const tasaConversion = totalEnviados > 0 ? Math.round((totalAprobados / totalEnviados) * 100) : 0;

  // Valor del pipeline (presupuestos activos que aún no cobró)
  const pipelineEstados = ['enviado','aprobado','produccion','listo','entregado'];
  const valorPipeline = pipelineEstados.reduce((s,e) => s + (funnel[e]?.valor||0), 0);

  return res.status(200).json({
    ok: true,
    data: {
      mes,
      kpis: {
        facturadoUYU: Number(facturadoUYU),
        facturadoUSD: Number(facturadoUSD),
        cobradoUYU: Number(cobradoUYU),
        cobradoUSD: Number(cobradoUSD),
        gastosMes: Number(gastosMes),
        gananciaNeta: Number(cobradoUYU) - Number(gastosMes),
        presActivos
      },
      estadosMes: estadosR.rows,
      gastosCategorias: gastosCatR.rows,
      serie,
      topClientes: topClientesR.rows,
      ultimosPresupuestos: ultimosR.rows,
      cobrosPendientes: pendientesR.rows,
      listos: listosR.rows,
      conversion: {
        funnel,
        tasaConversion,
        valorPipeline: Math.round(valorPipeline),
        totalEnviados,
        totalAprobados
      }
    }
  });
}
