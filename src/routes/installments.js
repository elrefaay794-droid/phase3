// routes/installments.js
const express = require('express');
const router  = express.Router();
const { all, get, run } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// تحديث الأقساط المتأخرة عند كل طلب
function syncOverdue() {
  run(`UPDATE payment_installments SET status='overdue', updated_at=datetime('now')
       WHERE status='pending' AND due_date < date('now') AND paid_amount < amount`);
}

// ── GET /api/installments ── (كل الأقساط مع فلاتر)
router.get('/', (req, res) => {
  syncOverdue();
  const { supplier_id, status, overdue_only } = req.query;
  let sql = `
    SELECT pi.*, s.name as supplier_name, s.code as supplier_code,
           po.po_number
    FROM payment_installments pi
    JOIN suppliers s ON pi.supplier_id = s.id
    LEFT JOIN purchase_orders po ON pi.po_id = po.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id)  { sql += ` AND pi.supplier_id=?`; params.push(supplier_id); }
  if (status)       { sql += ` AND pi.status=?`;      params.push(status); }
  if (overdue_only === 'true') { sql += ` AND pi.status='overdue'`; }
  sql += ` ORDER BY pi.due_date ASC`;

  res.json({ installments: all(sql, params) });
});

// ── GET /api/installments/dashboard ── (ملخص للوحة التحكم)
router.get('/dashboard', (req, res) => {
  syncOverdue();
  const overdue  = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount-paid_amount),0) as total FROM payment_installments WHERE status='overdue'`);
  const upcoming = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount-paid_amount),0) as total FROM payment_installments WHERE status='pending' AND due_date <= date('now','+30 days')`);
  const paid     = get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM payment_installments WHERE status='paid'`);

  const dueSoon = all(`
    SELECT pi.*, s.name as supplier_name, po.po_number
    FROM payment_installments pi
    JOIN suppliers s ON pi.supplier_id = s.id
    LEFT JOIN purchase_orders po ON pi.po_id = po.id
    WHERE pi.status IN ('pending','overdue')
    ORDER BY pi.due_date ASC LIMIT 10`);

  res.json({ overdue, upcoming, paid, due_soon: dueSoon });
});

module.exports = router;
