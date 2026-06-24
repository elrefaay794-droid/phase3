// routes/purchaseOrders.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');

router.use(authenticate);

function genPONumber() {
  const r = get(`SELECT COUNT(*) as c FROM purchase_orders`);
  return `PO-${String((r?.c||0)+1).padStart(5,'0')}`;
}

function calcPOTotals(items) {
  let subtotal = 0;
  const enriched = items.map(item => {
    const lineBeforeDisc = item.qty_ordered * item.unit_cost;
    const discAmt        = lineBeforeDisc * (item.discount_pct || 0) / 100;
    const lineTotal      = lineBeforeDisc - discAmt;
    subtotal += lineTotal;
    return { ...item, line_total: lineTotal };
  });
  return { enriched, subtotal };
}

// ── GET /api/purchase-orders ──
router.get('/', (req, res) => {
  const { supplier_id, status, from_date, to_date } = req.query;
  let sql = `
    SELECT po.*, s.name as supplier_name, s.code as supplier_code,
           l.name as location_name, u.full_name as created_by
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN locations l ON po.location_id = l.id
    LEFT JOIN users u ON po.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id) { sql += ` AND po.supplier_id=?`; params.push(supplier_id); }
  if (status)      { sql += ` AND po.status=?`;      params.push(status); }
  if (from_date)   { sql += ` AND po.order_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND po.order_date<=?`; params.push(to_date); }
  sql += ` ORDER BY po.created_at DESC LIMIT 300`;

  const orders = all(sql, params).map(po => ({
    ...po,
    balance_due: po.total - po.paid_amount,
  }));
  res.json({ orders, count: orders.length });
});

// ── GET /api/purchase-orders/:id ──
router.get('/:id', (req, res) => {
  const po = get(`
    SELECT po.*, s.name as supplier_name, s.code as supplier_code,
           l.name as location_name, u.full_name as created_by
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN locations l ON po.location_id = l.id
    LEFT JOIN users u ON po.user_id = u.id
    WHERE po.id=?`, [req.params.id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });

  const items = all(`
    SELECT poi.*, p.name as product_name, p.sku, p.unit
    FROM purchase_order_items poi
    JOIN products p ON poi.product_id = p.id
    WHERE poi.po_id=?`, [po.id]);

  const receipts = all(`
    SELECT pr.*, u.full_name as received_by
    FROM purchase_receipts pr
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE pr.po_id=?`, [po.id]);

  const payments = all(`SELECT * FROM supplier_payments WHERE po_id=? ORDER BY payment_date ASC`, [po.id]);
  const installs = all(`SELECT * FROM payment_installments WHERE po_id=? ORDER BY installment_number ASC`, [po.id]);

  res.json({ order: { ...po, balance_due: po.total - po.paid_amount }, items, receipts, payments, installments: installs });
});

// ── POST /api/purchase-orders ──
router.post('/', authorize('admin','manager'), (req, res) => {
  const { supplier_id, location_id, order_date, expected_date,
          discount_amount, tax_amount, notes, items, installments } = req.body;

  if (!supplier_id) return res.status(400).json({ error: 'المورد مطلوب' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });
  if (!get(`SELECT id FROM suppliers WHERE id=? AND is_active=1`,[supplier_id]))
    return res.status(404).json({ error: 'المورد غير موجود أو غير نشط' });

  const { enriched, subtotal } = calcPOTotals(items);
  const discAmt = parseFloat(discount_amount)||0;
  const taxAmt  = parseFloat(tax_amount)||0;
  const total   = subtotal - discAmt + taxAmt;

  const poId = transaction(() => {
    const poNumber = genPONumber();
    const id = insert(`
      INSERT INTO purchase_orders
      (po_number,supplier_id,location_id,order_date,expected_date,
       subtotal,discount_amount,tax_amount,total,paid_amount,notes,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
      [poNumber, supplier_id, location_id||null,
       order_date || new Date().toISOString().split('T')[0],
       expected_date||null, subtotal, discAmt, taxAmt, total, notes||null, req.user.id]);

    for (const item of enriched) {
      insert(`INSERT INTO purchase_order_items
        (po_id,product_id,qty_ordered,unit_cost,discount_pct,line_total)
        VALUES (?,?,?,?,?,?)`,
        [id, item.product_id, item.qty_ordered, item.unit_cost,
         item.discount_pct||0, item.line_total]);
    }

    // إنشاء جدول الأقساط إن وُجد
    if (Array.isArray(installments) && installments.length > 0) {
      installments.forEach((inst, idx) => {
        insert(`INSERT INTO payment_installments
          (supplier_id,po_id,installment_number,amount,due_date,notes)
          VALUES (?,?,?,?,?,?)`,
          [supplier_id, id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      });
    }

    return id;
  });

  logAction(req.user.id, 'create', 'purchase_order', poId, { supplier_id, total });
  const created = get(`SELECT * FROM purchase_orders WHERE id=?`,[poId]);
  res.status(201).json({ message: 'تم إنشاء أمر الشراء بنجاح', order: created });
});

// ── PUT /api/purchase-orders/:id/status ──
router.put('/:id/status', authorize('admin','manager'), (req, res) => {
  const { status } = req.body;
  const valid = ['draft','sent','partial','received','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  const po = get(`SELECT * FROM purchase_orders WHERE id=?`,[req.params.id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });

  run(`UPDATE purchase_orders SET status=?, updated_at=datetime('now') WHERE id=?`, [status, req.params.id]);
  logAction(req.user.id, 'status_change', 'purchase_order', req.params.id, { from: po.status, to: status });
  res.json({ message: 'تم تحديث الحالة', status });
});

// ── PUT /api/purchase-orders/:id ── (تعديل الـ PO مع إعادة حساب الإجماليات)
router.put('/:id', authorize('admin','manager'), (req, res) => {
  const { id } = req.params;
  const po = get(`SELECT * FROM purchase_orders WHERE id=?`,[id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });
  if (po.status === 'received')
    return res.status(400).json({ error: 'لا يمكن تعديل أمر شراء مكتمل الاستلام' });

  const { supplier_id, location_id, order_date, expected_date,
          discount_amount, tax_amount, notes, items } = req.body;

  transaction(() => {
    if (items && items.length > 0) {
      const { enriched, subtotal } = calcPOTotals(items);
      const discAmt = parseFloat(discount_amount) ?? po.discount_amount;
      const taxAmt  = parseFloat(tax_amount)      ?? po.tax_amount;
      const total   = subtotal - discAmt + taxAmt;

      run(`UPDATE purchase_orders SET
        supplier_id=?, location_id=?, order_date=?, expected_date=?,
        subtotal=?, discount_amount=?, tax_amount=?, total=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
        [supplier_id??po.supplier_id, location_id??po.location_id,
         order_date??po.order_date, expected_date??po.expected_date,
         subtotal, discAmt, taxAmt, total, notes??po.notes, id]);

      run(`DELETE FROM purchase_order_items WHERE po_id=?`,[id]);
      for (const item of enriched) {
        insert(`INSERT INTO purchase_order_items
          (po_id,product_id,qty_ordered,unit_cost,discount_pct,line_total)
          VALUES (?,?,?,?,?,?)`,
          [id, item.product_id, item.qty_ordered, item.unit_cost,
           item.discount_pct||0, item.line_total]);
      }
    }
  });

  res.json({ order: get(`SELECT * FROM purchase_orders WHERE id=?`,[id]) });
});

module.exports = router;
