// GET /api/setup — inicializa toda la base de datos (idempotente, llamar tras cada deploy)
import { getDB } from "./_lib/db.js";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = getDB();

  // Presupuestos (tabla existente, extendida)
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
  for (const col of [
    "ADD COLUMN cliente_id INTEGER",
    "ADD COLUMN estado TEXT NOT NULL DEFAULT 'borrador'",
    "ADD COLUMN moneda TEXT DEFAULT 'UYU'",
    "ADD COLUMN tipo_cambio REAL",
    "ADD COLUMN fecha_entrega TEXT",
    "ADD COLUMN notas TEXT",
    "ADD COLUMN enviado_whatsapp INTEGER DEFAULT 0",
    "ADD COLUMN created_by INTEGER",
    "ADD COLUMN updated_at TEXT",
    "ADD COLUMN updated_by INTEGER"
  ]) {
    try { await db.execute(`ALTER TABLE presupuestos ${col}`); } catch {}
  }

  // Historial de estados de presupuesto
  await db.execute(`
    CREATE TABLE IF NOT EXISTS presupuesto_estados (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      presupuesto_id  INTEGER NOT NULL,
      estado_anterior TEXT,
      estado_nuevo    TEXT NOT NULL,
      nota            TEXT,
      usuario_id      INTEGER NOT NULL DEFAULT 0,
      usuario_nombre  TEXT NOT NULL DEFAULT 'Sistema',
      created_at      TEXT DEFAULT (datetime('now'))
    )
  `);

  // Usuarios
  await db.execute(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre        TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol           TEXT NOT NULL DEFAULT 'operador',
      activo        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now')),
      last_login    TEXT
    )
  `);

  // Token blacklist
  await db.execute(`
    CREATE TABLE IF NOT EXISTS token_blacklist (
      token      TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )
  `);

  // Audit log
  await db.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id     INTEGER NOT NULL DEFAULT 0,
      usuario_nombre TEXT NOT NULL DEFAULT 'Sistema',
      accion         TEXT NOT NULL,
      entidad        TEXT NOT NULL,
      entidad_id     INTEGER,
      detalle        TEXT,
      ip             TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    )
  `);

  // Clientes
  await db.execute(`
    CREATE TABLE IF NOT EXISTS clientes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL,
      email      TEXT,
      telefono   TEXT,
      notas      TEXT,
      activo     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      created_by INTEGER
    )
  `);
  for (const col of [
    "ADD COLUMN tipo TEXT NOT NULL DEFAULT 'persona'",
    "ADD COLUMN empresa TEXT",
    "ADD COLUMN rut TEXT",
    "ADD COLUMN direccion TEXT"
  ]) { try { await db.execute(`ALTER TABLE clientes ${col}`); } catch {} }

  // Cobros
  await db.execute(`
    CREATE TABLE IF NOT EXISTS cobros (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      presupuesto_id INTEGER NOT NULL,
      cliente_id     INTEGER,
      monto          REAL NOT NULL,
      moneda         TEXT NOT NULL DEFAULT 'UYU',
      tipo_cambio    REAL,
      medio_pago     TEXT NOT NULL DEFAULT 'efectivo',
      fecha          TEXT NOT NULL,
      nota           TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      created_by     INTEGER
    )
  `);

  // Gastos
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gastos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria      TEXT NOT NULL DEFAULT 'otros',
      descripcion    TEXT NOT NULL,
      monto          REAL NOT NULL,
      moneda         TEXT NOT NULL DEFAULT 'UYU',
      tipo_cambio    REAL,
      fecha          TEXT NOT NULL,
      tipo           TEXT NOT NULL DEFAULT 'manual',
      presupuesto_id INTEGER,
      recurrente     INTEGER DEFAULT 0,
      gasto_fijo_id  INTEGER,
      created_at     TEXT DEFAULT (datetime('now')),
      created_by     INTEGER
    )
  `);
  for (const col of [
    "ADD COLUMN medio_pago TEXT DEFAULT 'efectivo'",
    "ADD COLUMN para_que TEXT"
  ]) { try { await db.execute(`ALTER TABLE gastos ${col}`); } catch {} }

  // Gastos fijos recurrentes
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gastos_fijos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre      TEXT NOT NULL,
      categoria   TEXT NOT NULL DEFAULT 'otros',
      monto       REAL NOT NULL,
      moneda      TEXT NOT NULL DEFAULT 'UYU',
      dia_del_mes INTEGER NOT NULL DEFAULT 1,
      activo      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  // Proveedores
  await db.execute(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL,
      rubro      TEXT,
      contacto   TEXT,
      telefono   TEXT,
      email      TEXT,
      rut        TEXT,
      direccion  TEXT,
      notas      TEXT,
      activo     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Insumos
  await db.execute(`
    CREATE TABLE IF NOT EXISTS insumos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre       TEXT NOT NULL,
      categoria    TEXT NOT NULL DEFAULT 'otros',
      tipo         TEXT,
      proveedor_id INTEGER,
      precio       REAL NOT NULL DEFAULT 0,
      moneda       TEXT NOT NULL DEFAULT 'UYU',
      unidad       TEXT NOT NULL DEFAULT 'kg',
      stock        REAL NOT NULL DEFAULT 0,
      notas        TEXT,
      activo       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now'))
    )
  `);
  for (const col of ["ADD COLUMN stock_min REAL DEFAULT 1"]) { try { await db.execute(`ALTER TABLE insumos ${col}`); } catch {} }

  // Productos (catálogo reutilizable)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS productos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre      TEXT NOT NULL,
      descripcion TEXT,
      precio_base REAL NOT NULL DEFAULT 0,
      moneda      TEXT NOT NULL DEFAULT 'UYU',
      mat         TEXT,
      notas       TEXT,
      activo      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  // Agenda
  await db.execute(`
    CREATE TABLE IF NOT EXISTS agenda (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo         TEXT NOT NULL,
      descripcion    TEXT,
      tipo           TEXT NOT NULL DEFAULT 'tarea',
      fecha          TEXT NOT NULL,
      hora           TEXT,
      presupuesto_id INTEGER,
      cliente_id     INTEGER,
      asignado_a     INTEGER,
      prioridad      TEXT NOT NULL DEFAULT 'normal',
      notas          TEXT,
      completado     INTEGER NOT NULL DEFAULT 0,
      creado_por     INTEGER,
      created_at     TEXT DEFAULT (datetime('now'))
    )
  `);

  // Notificaciones
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notificaciones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      titulo     TEXT NOT NULL,
      mensaje    TEXT,
      tipo       TEXT DEFAULT 'info',
      link_tipo  TEXT,
      link_id    INTEGER,
      leida      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Configuracion
  await db.execute(`
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    )
  `);
  for (const [k, v] of [
    ["tipo_cambio_usd_uyu", "42.5"],
    ["moneda_default", "UYU"],
    ["nombre_empresa", "ArteLab UY"],
    ["whatsapp_numero", "598"],
    ["margen_default", "50"],
    ["gastos_fijos_mes", ""]
  ]) {
    try { await db.execute({ sql: "INSERT OR IGNORE INTO configuracion (clave,valor) VALUES (?,?)", args: [k, v] }); } catch {}
  }

  // Usuario admin inicial
  const existing = await db.execute("SELECT id FROM usuarios WHERE email='admin@artelab.uy'");
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash("ArteLab2025!", 10);
    await db.execute({
      sql: "INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)",
      args: ["Admin", "admin@artelab.uy", hash, "admin"]
    });
  }

  return res.status(200).json({ ok: true, message: "Base de datos inicializada. Admin: admin@artelab.uy / ArteLab2025!" });
}
