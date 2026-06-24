// routes/supplierPayments.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');

router.use(authenticate);

function genPaymentNumber() {
  const r = get(`SELECT COUNT(*) as c FROM supplier_payments`);
  return `PAY-${String((r?.c||0)+1).padStart(5,'0')}`;
}

// ── GET /api/supplier-payments ──
router.get('/', (req, res) => {
  const { supplier_id, po_id, from_date, to_date } = req.query;
  let sql = `
    SELECT sp.*, s.name as supplier_name, po.po_number, u.full_name as created_by
    FROM supplier_payments sp
    JOIN suppliers s ON sp.supplier_id = s.id
    LEFT JOIN purchase_orders po ON sp.po_id = po.id
    LEFT JOIN users u ON sp.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id) { sql += ` AND sp.supplier_id=?`; params.push(supplier_id); }
  if (po_id)       { sql += ` AND sp.po_id=?`;       params.push(po_id); }
  if (from_date)   { sql += ` AND sp.payment_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND sp.payment_date<=?`; params.push(to_date); }
  sql += ` ORDER BY sp.payment_date DESC LIMIT 300`;
  res.json({ payments: all(sql, params) });
});

// ── POST /api/supplier-payments ──
router.post('/', authorize('admin','manager'), (req, res) => {
  const { supplier_id, po_id, amount, payment_method, payment_date, reference, notes,
          installment_id } = req.body;

  if (!supplier_id || !amount || amount <= 0)
    return res.status(400).json({ error: 'المورد والمبلغ مطلوبان' });
  if (!get(`SELECT id FROM suppliers WHERE id=?`,[supplier_id]))
    return res.status(404).json({ error: 'المورد غير موجود' });

  const payId = transaction(() => {
    const payNumber = genPaymentNumber();
    const id = insert(`
      INSERT INTO supplier_payments
      (payment_number,supplier_id,po_id,amount,payment_method,payment_date,reference,notes,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [payNumber, supplier_id, po_id||null, parseFloat(amount),
       payment_method||'cash',
       payment_date || new Date().toISOString().split('T')[0],
       reference||null, notes||null, req.user.id]);

    // تحديث paid_amount في أمر الشراء
    if (po_id) {
      const po = get(`SELECT * FROM purchase_orders WHERE id=?`,[po_id]);
      if (po) {
        run(`UPDATE purchase_orders SET paid_amount = paid_amount + ?, updated_at=datetime('now') WHERE id=?`,
          [parseFloat(amount), po_id]);
      }
    }

    // ربط بقسط محدد وتحديثه
    if (installment_id) {
      const inst = get(`SELECT * FROM payment_installments WHERE id=?`,[installment_id]);
      if (inst) {
        const newPaid = inst.paid_amount + parseFloat(amount);
        const newStatus = newPaid >= inst.amount ? 'paid' : 'partial';
        run(`UPDATE payment_installments SET paid_amount=?, status=?, payment_id=?, updated_at=datetime('now') WHERE id=?`,
          [newPaid, newStatus, id, installment_id]);
      }
    }

    return id;
  });

  logAction(req.user.id, 'create', 'supplier_payment', payId, { supplier_id, amount, po_id });
  res.status(201).json({
    message: 'تم تسجيل الدفعة بنجاح',
    payment: get(`SELECT * FROM supplier_payments WHERE id=?`,[payId]),
  });
});

// ── DELETE /api/supplier-payments/:id ── (إلغاء الدفعة)
router.delete('/:id', authorize('admin'), (req, res) => {
  const pay = get(`SELECT * FROM supplier_payments WHERE id=?`,[req.params.id]);
  if (!pay) return res.status(404).json({ error: 'الدفعة غير موجودة' });

  transaction(() => {
    // استرداد المبلغ من أمر الشراء
    if (pay.po_id) {
      run(`UPDATE purchase_orders SET paid_amount = MAX(0, paid_amount - ?), updated_at=datetime('now') WHERE id=?`,
        [pay.amount, pay.po_id]);
    }
    // تراجع القسط إن كان مرتبطاً
    run(`UPDATE payment_installments SET paid_amount=MAX(0,paid_amount-?), status='pending', payment_id=NULL
         WHERE payment_id=?`, [pay.amount, pay.id]);

    run(`DELETE FROM supplier_payments WHERE id=?`,[req.params.id]);
  });

  logAction(req.user.id, 'delete', 'supplier_payment', req.params.id, null);
  res.json({ message: 'تم إلغاء الدفعة بنجاح' });
});

module.exports = router;
