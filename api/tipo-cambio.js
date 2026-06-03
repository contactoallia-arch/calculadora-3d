// GET /api/tipo-cambio — proxy server-side para evitar CORS
// Consulta la cotización USD/UYU desde Frankfurter (datos del BCE/mercado)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Método no permitido" });

  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=UYU");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const rate = d.rates?.UYU;
    if (!rate) throw new Error("Sin datos de cotización");
    return res.status(200).json({ ok: true, rate, date: d.date, base: "USD", to: "UYU" });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
