// utils/customerLedger.js
// حساب رصيد العميل في الوقت الفعلي
const { get } = require('../db/database');

function getCustomerBalance(customerId) {
  const customer = get(`SELECT opening_balance FROM customers WHERE id=?`,[customerId]);
  if (!customer) return null;

  const invTotals = get(`
    SELECT COALESCE(SUM(total),0) as total_invoiced
    FROM invoices WHERE customer_id=? AND status NOT IN ('draft','cancelled')
  `,[customerId]);

  const payTotals = get(`
    SELECT COALESCE(SUM(amount),0) as total_paid
    FROM customer_payments WHERE customer_id=?
  `,[customerId]);

  const returnTotals = get(`
    SELECT COALESCE(SUM(total_refund),0) as total_refunded
    FROM sales_returns WHERE customer_id=? AND status='completed'
  `,[customerId]);

  const totalInvoiced  = (customer.opening_balance||0) + (invTotals.total_invoiced||0);
  const totalPaid      = (payTotals.total_paid||0) + (returnTotals.total_refunded||0);
  const balance        = totalInvoiced - totalPaid; // موجب = العميل مدين لنا

  return {
    opening_balance:   customer.opening_balance||0,
    total_invoiced:    invTotals.total_invoiced||0,
    total_paid:        payTotals.total_paid||0,
    total_refunded:    returnTotals.total_refunded||0,
    balance,
  };
}

function syncCustomerInstallments(run_fn) {
  (run_fn || require('../db/database').run)(`
    UPDATE customer_installments SET status='overdue', updated_at=datetime('now')
    WHERE status='pending' AND due_date < date('now') AND paid_amount < amount
  `);
}

module.exports = { getCustomerBalance, syncCustomerInstallments };
