// routes/purchaseReceipts.js
// إيصالات الاستلام — تحدّث المخزون تلقائياً عند الحفظ
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');

router.use(authenticate);

function genReceiptNumber() {
  const r = get(`SELECT COUNT(*) as c FROM purchase_receipts`);
  return `GRN-${String((r?.c||0)+1).padStart(5,'0')}`;
}

// ── GET /api/purchase-receipts ──
router.get('/', (req, res) => {
  const { po_id, supplier_id } = req.query;
  let sql = `
    SELECT pr.*, po.po_number, s.name as supplier_name, l.name as location_name, u.full_name as received_by
    FROM purchase_receipts pr
    JOIN purchase_orders po ON pr.po_id = po.id
    JOIN suppliers s ON pr.supplier_id = s.id
    JOIN locations l ON pr.location_id = l.id
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (po_id)       { sql += ` AND pr.po_id=?`;        params.push(po_id); }
  if (supplier_id) { sql += ` AND pr.supplier_id=?`;  params.push(supplier_id); }
  sql += ` ORDER BY pr.created_at DESC LIMIT 200`;

  const receipts = all(sql, params);
  res.json({ receipts, count: receipts.length });
});

// ── GET /api/purchase-receipts/:id ──
router.get('/:id', (req, res) => {
  const r = get(`
    SELECT pr.*, po.po_number, s.name as supplier_name, l.name as location_name, u.full_name as received_by
    FROM purchase_receipts pr
    JOIN purchase_orders po ON pr.po_id = po.id
    JOIN suppliers s ON pr.supplier_id = s.id
    JOIN locations l ON pr.location_id = l.id
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE pr.id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'الإيصال غير موجود' });

  const items = all(`
    SELECT pri.*, p.name as product_name, p.sku, p.unit
    FROM purchase_receipt_items pri
    JOIN products p ON pri.product_id = p.id
    WHERE pri.receipt_id=?`, [r.id]);

  res.json({ receipt: r, items });
});

// ── POST /api/purchase-receipts ── (الأهم: يحدّث المخزون + qty_received في PO)
router.post('/', authorize('admin','manager','warehouse'), (req, res) => {
  const { po_id, location_id, receipt_date, notes, items } = req.body;

  if (!po_id || !location_id)
    return res.status(400).json({ error: 'أمر الشراء والموقع مطلوبان' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب تحديد منتج واحد على الأقل' });

  const po = get(`SELECT * FROM purchase_orders WHERE id=?`,[po_id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });
  if (po.status === 'cancelled')
    return res.status(400).json({ error: 'لا يمكن الاستلام على أمر شراء ملغي' });

  // التحقق من صلاحية الموقع
  const allowedIds = getAllowedLocationIds(req.user);
  if (allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية على هذا الموقع' });

  // التحقق من الكميات المتبقية
  for (const item of items) {
    const poItem = get(`SELECT * FROM purchase_order_items WHERE id=? AND po_id=?`,
      [item.po_item_id, po_id]);
    if (!poItem) return res.status(400).json({ error: `البند رقم ${item.po_item_id} غير موجود` });
    const remaining = poItem.qty_ordered - poItem.qty_received;
    if (item.qty_received > remaining)
      return res.status(400).json({
        error: `الكمية المطلوبة (${item.qty_received}) تتجاوز المتبقي (${remaining}) للمنتج رقم ${poItem.product_id}`
      });
  }

  const receiptId = transaction(() => {
    const receiptNumber = genReceiptNumber();
    const rId = insert(`
      INSERT INTO purchase_receipts (receipt_number,po_id,supplier_id,location_id,receipt_date,notes,user_id)
      VALUES (?,?,?,?,?,?,?)`,
      [receiptNumber, po_id, po.supplier_id, location_id,
       receipt_date || new Date().toISOString().split('T')[0],
       notes||null, req.user.id]);

    for (const item of items) {
      const poItem = get(`SELECT * FROM purchase_order_items WHERE id=?`,[item.po_item_id]);
      const unitCost = item.unit_cost ?? poItem.unit_cost;

      insert(`INSERT INTO purchase_receipt_items (receipt_id,po_item_id,product_id,qty_received,unit_cost)
        VALUES (?,?,?,?,?)`,
        [rId, item.po_item_id, poItem.product_id, item.qty_received, unitCost]);

      // تحديث qty_received في بند PO
      run(`UPDATE purchase_order_items SET qty_received = qty_received + ? WHERE id=?`,
        [item.qty_received, item.po_item_id]);

      // ─── تحديث المخزون (الأهم) ───
      const inv = get(`SELECT * FROM inventory WHERE product_id=? AND location_id=?`,
        [poItem.product_id, location_id]);
      const before = inv?.quantity || 0;
      const after  = before + item.qty_received;

      if (inv) {
        run(`UPDATE inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`,
          [after, poItem.product_id, location_id]);
      } else {
        insert(`INSERT INTO inventory (product_id,location_id,quantity) VALUES (?,?,?)`,
          [poItem.product_id, location_id, after]);
      }

      insert(`INSERT INTO stock_movements
        (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,
         reference_type,reference_id,notes,user_id)
        VALUES (?,?,'in',?,?,?,'purchase_receipt',?,'استلام بضاعة — إيصال '+?,?)`,
        [poItem.product_id, location_id, item.qty_received, before, after,
         rId, receiptNumber, req.user.id]);

      // تحديث سعر التكلفة في جدول المنتجات (weighted average)
      const currentProduct = get(`SELECT cost_price FROM products WHERE id=?`,[poItem.product_id]);
      const currentStock   = after - item.qty_received; // الكمية قبل الاستلام
      const newCost = currentStock > 0
        ? ((currentProduct.cost_price * currentStock) + (unitCost * item.qty_received)) / after
        : unitCost;
      run(`UPDATE products SET cost_price=?, updated_at=datetime('now') WHERE id=?`,
        [newCost, poItem.product_id]);
    }

    // تحديث حالة PO بناءً على الكميات المستلمة
    const allItems = all(`SELECT qty_ordered, qty_received FROM purchase_order_items WHERE po_id=?`,[po_id]);
    const allReceived = allItems.every(i => i.qty_received >= i.qty_ordered);
    const anyReceived = allItems.some(i => i.qty_received > 0);
    const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : po.status;
    run(`UPDATE purchase_orders SET status=?, updated_at=datetime('now') WHERE id=?`,[newStatus, po_id]);

    return rId;
  });

  logAction(req.user.id, 'create', 'purchase_receipt', receiptId, { po_id, location_id });
  res.status(201).json({
    message: 'تم تسجيل الاستلام وتحديث المخزون بنجاح',
    receipt: get(`SELECT * FROM purchase_receipts WHERE id=?`,[receiptId]),
  });
});

module.exports = router;
