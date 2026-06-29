// routes/customerPayments.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction }               = require('../utils/auditLog');
const { sendPaymentTelegramNotification } = require('../utils/telegram');

router.use(authenticate);

function genPaymentNumber() {
  const r = get(`SELECT COUNT(*) as c FROM customer_payments`);
  return `RCP-${String((r?.c||0)+1).padStart(5,'0')}`;
}

// GET /api/customer-payments
router.get('/', (req, res) => {
  const { customer_id, invoice_id, from_date, to_date } = req.query;
  let sql = `
    SELECT cp.*, c.name as customer_name, inv.invoice_number, u.full_name as created_by
    FROM customer_payments cp
    JOIN customers c ON cp.customer_id=c.id
    LEFT JOIN invoices inv ON cp.invoice_id=inv.id
    LEFT JOIN users u ON cp.user_id=u.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND cp.customer_id=?`; params.push(customer_id); }
  if (invoice_id)  { sql += ` AND cp.invoice_id=?`;  params.push(invoice_id); }
  if (from_date)   { sql += ` AND cp.payment_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND cp.payment_date<=?`; params.push(to_date); }
  sql += ` ORDER BY cp.payment_date DESC LIMIT 300`;
  res.json({ payments: all(sql, params) });
});

// POST /api/customer-payments
router.post('/', authorize('admin','manager','sales'), (req, res) => {
  const { customer_id, invoice_id, amount, payment_method, payment_date,
          reference, notes, installment_id } = req.body;

  if (!customer_id || !amount || amount <= 0)
    return res.status(400).json({ error: 'العميل والمبلغ مطلوبان' });

  if (!get(`SELECT id FROM customers WHERE id=?`,[customer_id]))
    return res.status(404).json({ error: 'العميل غير موجود' });

  const payId = transaction(() => {
    const payNumber = genPaymentNumber();
    const id = insert(`
      INSERT INTO customer_payments
      (payment_number,customer_id,invoice_id,amount,payment_method,payment_date,reference,notes,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [payNumber, customer_id, invoice_id||null, parseFloat(amount),
       payment_method||'cash',
       payment_date||new Date().toISOString().split('T')[0],
       reference||null, notes||null, req.user.id]
    );

    // تحديث paid_amount في الفاتورة وحالتها
    if (invoice_id) {
      const inv = get(`SELECT * FROM invoices WHERE id=?`,[invoice_id]);
      if (inv) {
        const newPaid  = inv.paid_amount + parseFloat(amount);
        const newStatus = newPaid >= inv.total ? 'paid'
                        : newPaid > 0          ? 'partial'
                        : inv.status;
        run(`UPDATE invoices SET paid_amount=?, status=?, updated_at=datetime('now') WHERE id=?`,
          [newPaid, newStatus, invoice_id]);
      }
    }

    // ربط بقسط وتحديثه
    if (installment_id) {
      const inst = get(`SELECT * FROM customer_installments WHERE id=?`,[installment_id]);
      if (inst) {
        const newPaid  = inst.paid_amount + parseFloat(amount);
        const newStatus = newPaid >= inst.amount ? 'paid' : 'partial';
        run(`UPDATE customer_installments SET paid_amount=?, status=?, payment_id=?, updated_at=datetime('now') WHERE id=?`,
          [newPaid, newStatus, id, installment_id]);
      }
    }

    return id;
  });

  logAction(req.user.id,'create','customer_payment',payId,{ customer_id, amount, invoice_id });

  // إرسال إشعار تحصيل الدفعة إلى تيليجرام
  const paymentForMsg = get(`SELECT * FROM customer_payments WHERE id=?`,[payId]);
  const customerForMsg = get(`SELECT * FROM customers WHERE id=?`,[customer_id]);
  const invoiceForMsg = invoice_id ? get(`SELECT * FROM invoices WHERE id=?`,[invoice_id]) : null;
  sendPaymentTelegramNotification(paymentForMsg, customerForMsg, invoiceForMsg);

  res.status(201).json({ message:'تم تسجيل الدفعة بنجاح', payment: get(`SELECT * FROM customer_payments WHERE id=?`,[payId]) });
});

// DELETE /api/customer-payments/:id (إلغاء تحصيل — admin فقط)
router.delete('/:id', authorize('admin'), (req, res) => {
  const pay = get(`SELECT * FROM customer_payments WHERE id=?`,[req.params.id]);
  if (!pay) return res.status(404).json({ error: 'الدفعة غير موجودة' });

  transaction(() => {
    if (pay.invoice_id) {
      run(`UPDATE invoices SET paid_amount=MAX(0,paid_amount-?), updated_at=datetime('now') WHERE id=?`,[pay.amount, pay.invoice_id]);
      const inv = get(`SELECT * FROM invoices WHERE id=?`,[pay.invoice_id]);
      if (inv) {
        const status = inv.paid_amount <= 0 ? 'confirmed' : inv.paid_amount < inv.total ? 'partial' : 'paid';
        run(`UPDATE invoices SET status=? WHERE id=?`,[status, pay.invoice_id]);
      }
    }
    run(`UPDATE customer_installments SET paid_amount=MAX(0,paid_amount-?), status='pending', payment_id=NULL WHERE payment_id=?`,
      [pay.amount, pay.id]);
    run(`DELETE FROM customer_payments WHERE id=?`,[req.params.id]);
  });

  logAction(req.user.id,'delete','customer_payment',req.params.id,null);
  res.json({ message:'تم إلغاء الدفعة بنجاح' });
});

module.exports = router;