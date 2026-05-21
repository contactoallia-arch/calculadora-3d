<?php
require_once __DIR__ . '/../config.php';
setHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') err('Método no permitido', 405);

try {
    $db = getDB();
    $rows = $db->query(
        'SELECT id, pieza, cliente, mat, qty, precio, margen, fecha, snap
         FROM presupuestos
         ORDER BY id DESC
         LIMIT 100'
    )->fetchAll();

    // Decodificar snap JSON para cada fila
    foreach ($rows as &$r) {
        $r['id']     = (int)   $r['id'];
        $r['qty']    = (int)   $r['qty'];
        $r['precio'] = (float) $r['precio'];
        $r['margen'] = (int)   $r['margen'];
        $r['snap']   = $r['snap'] ? json_decode($r['snap'], true) : null;
    }
    ok($rows);
} catch (PDOException $e) {
    err('Error al listar: ' . $e->getMessage(), 500);
}
