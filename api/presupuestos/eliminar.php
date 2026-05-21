<?php
require_once __DIR__ . '/../config.php';
setHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') err('Método no permitido', 405);

$body = json_decode(file_get_contents('php://input'), true);
$id   = isset($body['id']) ? (int) $body['id'] : 0;
$all  = !empty($body['all']);

if (!$id && !$all) err('ID requerido');

try {
    $db = getDB();
    if ($all) {
        $db->exec('DELETE FROM presupuestos');
    } else {
        $st = $db->prepare('DELETE FROM presupuestos WHERE id = ?');
        $st->execute([$id]);
        if ($st->rowCount() === 0) err('Presupuesto no encontrado', 404);
    }
    ok();
} catch (PDOException $e) {
    err('Error al eliminar: ' . $e->getMessage(), 500);
}
