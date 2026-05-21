<?php
require_once __DIR__ . '/../config.php';
setHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') err('Método no permitido', 405);

$body = json_decode(file_get_contents('php://input'), true);
if (!$body) err('JSON inválido');

$pieza   = trim($body['pieza']   ?? 'Sin nombre');
$cliente = trim($body['cliente'] ?? '—');
$mat     = trim($body['mat']     ?? '');
$qty     = (int)   ($body['qty']    ?? 1);
$precio  = (float) ($body['precio'] ?? 0);
$margen  = (int)   ($body['margen'] ?? 0);
$fecha   = $body['fecha'] ?? date('d/m/Y');
$snap    = $body['snap']  ?? null;   // JSON completo del formulario

if ($precio <= 0) err('Precio inválido');

try {
    $db = getDB();
    $st = $db->prepare(
        'INSERT INTO presupuestos (pieza, cliente, mat, qty, precio, margen, fecha, snap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $st->execute([
        $pieza, $cliente, $mat, $qty,
        $precio, $margen, $fecha,
        $snap ? json_encode($snap) : null,
    ]);
    ok(['id' => (int) $db->lastInsertId()]);
} catch (PDOException $e) {
    err('Error al guardar: ' . $e->getMessage(), 500);
}
