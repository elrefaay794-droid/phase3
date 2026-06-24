// routes/inventory.js
const express = require('express');
const router = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds, buildLocationFilter } = require('../utils/locationPermissions');

router.use(authenticate);

// GET /api/inventory/overview
router.get('/overview', (req, res) => {
  const allowedIds = getAllowedLocationIds(req.user);
  const { location_id } = req.query;

  // لو المستخدم حدّد موقع معين بالفلتر، تأكد إنه مسموح له
  if (location_id && allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية لهذا الموقع' });

  let locFilter = buildLocationFilter(allowedIds, 'l');
  const params = [];
  if (location_id) {
    locFilter += ` AND l.id = ?`;
    params.push(location_id);
  }

  const rows = all(`
    SELECT p.id as product_id, p.sku, p.barcode, p.name, p.unit, p.min_stock_threshold, p.image_path,
           l.id as location_id, l.name as location_name, l.type as location_type,
           COALESCE(i.quantity, 0) as quantity
    FROM products p
    CROSS JOIN locations l
    LEFT JOIN inventory i ON i.product_id = p.id AND i.location_id = l.id
    WHERE p.is_active = 1 AND l.is_active = 1 ${locFilter}
    ORDER BY p.name ASC, l.id ASC
  `, params);

  res.json({ inventory: rows });
});

// GET /api/inventory/low-stock
router.get('/low-stock', (req, res) => {
  const allowedIds = getAllowedLocationIds(req.user);
  const locFilter = buildLocationFilter(allowedIds, 'l');

  const products = all(`SELECT * FROM products WHERE is_active = 1`);
  const lowStockItems = [];

  for (const p of products) {
    // الإجمالي فقط من المواقع المسموحة للمستخدم
    const totals = get(`
      SELECT COALESCE(SUM(i.quantity), 0) as total
      FROM inventory i
      JOIN locations l ON i.location_id = l.id
      WHERE i.product_id = ? AND l.is_active = 1 ${locFilter}
    `, [p.id]);

    if (totals.total <= p.min_stock_threshold) {
      const byLocation = all(`
        SELECT l.name as location_name, COALESCE(i.quantity, 0) as quantity
        FROM locations l
        LEFT JOIN inventory i ON i.location_id = l.id AND i.product_id = ?
        WHERE l.is_active = 1 ${locFilter}
      `, [p.id]);

      lowStockItems.push({
        product_id: p.id, sku: p.sku, name: p.name, unit: p.unit,
        image_path: p.image_path, min_stock_threshold: p.min_stock_threshold,
        total_quantity: totals.total, stock_by_location: byLocation,
      });
    }
  }

  res.json({ low_stock_products: lowStockItems, count: lowStockItems.length });
});

// POST /api/inventory/adjust
router.post('/adjust', authorize('admin', 'manager', 'warehouse'), (req, res) => {
  const { product_id, location_id, new_quantity, notes } = req.body;

  if (!product_id || !location_id || new_quantity === undefined)
    return res.status(400).json({ error: 'يرجى تحديد المنتج والموقع والكمية الجديدة' });

  // التحقق من صلاحية الموقع
  const allowedIds = getAllowedLocationIds(req.user);
  if (allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية للتعديل في هذا الموقع' });

  const newQty = parseFloat(new_quantity);
  if (isNaN(newQty) || newQty < 0)
    return res.status(400).json({ error: 'الكمية يجب أن تكون رقماً أكبر من أو يساوي صفر' });

  const product = get(`SELECT * FROM products WHERE id = ?`, [product_id]);
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (!product.allow_fractional_qty && newQty % 1 !== 0)
    return res.status(400).json({ error: 'هذا المنتج لا يسمح بكميات كسرية' });

  const result = transaction(() => {
    const inv = get(`SELECT * FROM inventory WHERE product_id = ? AND location_id = ?`, [product_id, location_id]);
    const qtyBefore = inv ? inv.quantity : 0;

    if (inv) {
      run(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND location_id = ?`,
        [newQty, product_id, location_id]);
    } else {
      insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, ?)`,
        [product_id, location_id, newQty]);
    }

    insert(`INSERT INTO stock_movements
      (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, notes, user_id)
      VALUES (?, ?, 'adjustment', ?, ?, ?, 'manual_adjustment', ?, ?)`,
      [product_id, location_id, newQty - qtyBefore, qtyBefore, newQty, notes || 'تعديل يدوي', req.user.id]);

    return { qtyBefore, newQty };
  });

  logAction(req.user.id, 'adjust_stock', 'product', product_id, { location_id, before: result.qtyBefore, after: result.newQty });
  res.json({ message: 'تم تعديل الكمية بنجاح', quantity_before: result.qtyBefore, quantity_after: result.newQty });
});

// GET /api/inventory/movements
router.get('/movements', (req, res) => {
  const allowedIds = getAllowedLocationIds(req.user);
  const { product_id, location_id, movement_type, from_date, to_date } = req.query;

  if (location_id && allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية لهذا الموقع' });

  const locFilter = buildLocationFilter(allowedIds, 'l');
  let sql = `
    SELECT sm.*, p.name as product_name, p.sku, l.name as location_name, u.full_name as user_name
    FROM stock_movements sm
    JOIN products p ON sm.product_id = p.id
    JOIN locations l ON sm.location_id = l.id
    LEFT JOIN users u ON sm.user_id = u.id
    WHERE 1=1 ${locFilter}
  `;
  const params = [];
  if (product_id)     { sql += ` AND sm.product_id = ?`;    params.push(product_id); }
  if (location_id)    { sql += ` AND sm.location_id = ?`;   params.push(location_id); }
  if (movement_type)  { sql += ` AND sm.movement_type = ?`; params.push(movement_type); }
  if (from_date)      { sql += ` AND sm.created_at >= ?`;   params.push(from_date); }
  if (to_date)        { sql += ` AND sm.created_at <= ?`;   params.push(to_date); }
  sql += ` ORDER BY sm.created_at DESC LIMIT 500`;

  res.json({ movements: all(sql, params) });
});

module.exports = router;
