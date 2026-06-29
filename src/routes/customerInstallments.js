// routes/customerInstallments.js
const express = require('express');
const router  = express.Router();
const { all, get, run } = require('../db/database');
const { authenticate }  = require('../middleware/auth');
const { syncCustomerInstallments } = require('../utils/customerLedger');

router.use(authenticate);

// GET /api/customer-installments
router.get('/', (req, res) => {
  syncCustomerInstallments();
  const { customer_id, status, invoice_id, overdue_only } = req.query;
  let sql = `
    SELECT ci.*, c.name as customer_name, c.code as customer_code,
           inv.invoice_number
    FROM customer_installments ci
    JOIN customers c ON ci.customer_id=c.id
    JOIN invoices inv ON ci.invoice_id=inv.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND ci.customer_id=?`; params.push(customer_id); }
  if (invoice_id)  { sql += ` AND ci.invoice_id=?`;  params.push(invoice_id); }
  if (status)      { sql += ` AND ci.status=?`;      params.push(status); }
  if (overdue_only === 'true') sql += ` AND ci.status='overdue'`;
  sql += ` ORDER BY ci.due_date ASC`;
  res.json({ installments: all(sql, params) });
});

// GET /api/customer-installments/dashboard
router.get('/dashboard', (req, res) => {
  syncCustomerInstallments();
  const overdue  = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount-paid_amount),0) as total FROM customer_installments WHERE status='overdue'`);
  const upcoming = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount-paid_amount),0) as total FROM customer_installments WHERE status='pending' AND due_date <= date('now','+30 days')`);
  const paid     = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM customer_installments WHERE status='paid'`);

  const dueSoon = all(`
    SELECT ci.*, c.name as customer_name, c.phone as customer_phone, inv.invoice_number
    FROM customer_installments ci
    JOIN customers c ON ci.customer_id=c.id
    JOIN invoices inv ON ci.invoice_id=inv.id
    WHERE ci.status IN ('pending','overdue')
    ORDER BY ci.due_date ASC LIMIT 15`);

  res.json({ overdue, upcoming, paid, due_soon: dueSoon });
});

module.exports = router;
