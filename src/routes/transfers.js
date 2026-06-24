// routes/transfers.js
const express = require('express');
const router = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds } = require('../utils/locationPermissions');

router.use(authenticate);

function generateTransferNumber() {
  const result = get(`SELECT COUNT(*) as count FROM stock_transfers`);
  return `TRF-${String((result?.count || 0) + 1).padStart(5, '0')}`;
}

// GET /api/transfers
router.get('/', (req, res) => {
  const allowedIds = getAllowedLocationIds(req.user);

  // يعرض التحويلات التي يكون فيها المصدر أو الوجهة ضمن مواقعه المسموحة
  let locCondition = '';
  if (allowedIds) {
    const ids = allowedIds.join(',');
    locCondition = `AND (st.from_location_id IN (${ids}) OR st.to_location_id IN (${ids}))`;
  }

  const transfers = all(`
    SELECT st.*,
           fl.name as from_location_name, tl.name as to_location_name,
           u.full_name as user_name
    FROM stock_transfers st
    JOIN locations fl ON st.from_location_id = fl.id
    JOIN locations tl ON st.to_location_id = tl.id
    LEFT JOIN users u ON st.user_id = u.id
    WHERE 1=1 ${locCondition}
    ORDER BY st.created_at DESC LIMIT 200
  `);

  const withItems = transfers.map(t => ({
    ...t,
    items: all(`
      SELECT sti.*, p.name as product_name, p.sku, p.unit
      FROM stock_transfer_items sti JOIN products p ON sti.product_id = p.id
      WHERE sti.transfer_id = ?
    `, [t.id]),
  }));

  res.json({ transfers: withItems, count: withItems.length });
});

// POST /api/transfers
router.post('/', authorize('admin', 'manager', 'warehouse'), (req, res) => {
  const { from_location_id, to_location_id, items, notes } = req.body;

  if (!from_location_id || !to_location_id)
    return res.status(400).json({ error: 'يرجى تحديد الموقع المصدر والوجهة' });
  if (Number(from_location_id) === Number(to_location_id))
    return res.status(400).json({ error: 'لا يمكن التحويل من وإلى نفس الموقع' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب تحديد منتج واحد على الأقل' });

  // التحقق من صلاحية الموقعين
  const allowedIds = getAllowedLocationIds(req.user);
  if (allowedIds) {
    if (!allowedIds.includes(Number(from_location_id)))
      return res.status(403).json({ error: 'ليس لديك صلاحية على الموقع المصدر' });
    if (!allowedIds.includes(Number(to_location_id)))
      return res.status(403).json({ error: 'ليس لديك صلاحية على الموقع الوجهة' });
  }

  const fromLocation = get(`SELECT * FROM locations WHERE id = ?`, [from_location_id]);
  const toLocation   = get(`SELECT * FROM locations WHERE id = ?`, [to_location_id]);
  if (!fromLocation) return res.status(404).json({ error: 'الموقع المصدر غير موجود' });
  if (!toLocation)   return res.status(404).json({ error: 'الموقع الوجهة غير موجود' });

  // التحقق من الكميات أولاً
  for (const item of items) {
    const { product_id, quantity } = item;
    if (!product_id || !quantity || quantity <= 0)
      return res.status(400).json({ error: 'كل عنصر يجب أن يحتوي على منتج وكمية صحيحة' });

    const product = get(`SELECT * FROM products WHERE id = ?`, [product_id]);
    if (!product) return res.status(404).json({ error: `المنتج رقم ${product_id} غير موجود` });
    if (!product.allow_fractional_qty && quantity % 1 !== 0)
      return res.status(400).json({ error: `"${product.name}" لا يسمح بكميات كسرية` });

    const stock = get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ?`,
      [product_id, from_location_id]);
    const available = stock?.quantity || 0;
    if (available < quantity)
      return res.status(400).json({
        error: `الكمية المتوفرة من "${product.name}" في ${fromLocation.name} هي ${available} فقط`,
      });
  }

  const transferId = transaction(() => {
    const transferNumber = generateTransferNumber();
    const newId = insert(
      `INSERT INTO stock_transfers (transfer_number, from_location_id, to_location_id, status, notes, user_id)
       VALUES (?, ?, ?, 'completed', ?, ?)`,
      [transferNumber, from_location_id, to_location_id, notes || null, req.user.id]
    );

    for (const item of items) {
      const qty = parseFloat(item.quantity);
      insert(`INSERT INTO stock_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)`,
        [newId, item.product_id, qty]);

      const fromStock = get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ?`,
        [item.product_id, from_location_id]);
      const fromBefore = fromStock.quantity;
      const fromAfter  = fromBefore - qty;
      run(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND location_id = ?`,
        [fromAfter, item.product_id, from_location_id]);
      insert(`INSERT INTO stock_movements
        (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, notes, user_id)
        VALUES (?, ?, 'transfer_out', ?, ?, ?, 'transfer', ?, ?, ?)`,
        [item.product_id, from_location_id, -qty, fromBefore, fromAfter, newId, `تحويل إلى ${toLocation.name}`, req.user.id]);

      const toStock = get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ?`,
        [item.product_id, to_location_id]);
      const toBefore = toStock?.quantity || 0;
      const toAfter  = toBefore + qty;
      if (toStock) {
        run(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND location_id = ?`,
          [toAfter, item.product_id, to_location_id]);
      } else {
        insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, ?)`,
          [item.product_id, to_location_id, toAfter]);
      }
      insert(`INSERT INTO stock_movements
        (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, notes, user_id)
        VALUES (?, ?, 'transfer_in', ?, ?, ?, 'transfer', ?, ?, ?)`,
        [item.product_id, to_location_id, qty, toBefore, toAfter, newId, `تحويل من ${fromLocation.name}`, req.user.id]);
    }
    return newId;
  });

  logAction(req.user.id, 'create', 'transfer', transferId, { from_location_id, to_location_id });
  res.status(201).json({ message: 'تم التحويل بنجاح', transfer: get(`SELECT * FROM stock_transfers WHERE id = ?`, [transferId]) });
});

module.exports = router;
