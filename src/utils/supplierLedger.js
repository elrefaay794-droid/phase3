// utils/supplierLedger.js
// حساب رصيد المورد في الوقت الفعلي من مجموع الأوامر والمدفوعات
const { get, all } = require('../db/database');

function getSupplierBalance(supplierId) {
  const supplier = get(`SELECT opening_balance FROM suppliers WHERE id = ?`, [supplierId]);
  if (!supplier) return null;

  // إجمالي قيمة أوامر الشراء المستلمة أو جزئياً
  const poTotals = get(`
    SELECT COALESCE(SUM(total), 0) as total_invoiced
    FROM purchase_orders
    WHERE supplier_id = ? AND status IN ('partial','received')
  `, [supplierId]);

  // إجمالي المدفوعات
  const payTotals = get(`
    SELECT COALESCE(SUM(amount), 0) as total_paid
    FROM supplier_payments
    WHERE supplier_id = ?
  `, [supplierId]);

  const totalInvoiced = (supplier.opening_balance || 0) + (poTotals.total_invoiced || 0);
  const totalPaid     = payTotals.total_paid || 0;
  const balance       = totalInvoiced - totalPaid;

  return {
    opening_balance:  supplier.opening_balance || 0,
    total_invoiced:   poTotals.total_invoiced || 0,
    total_paid:       totalPaid,
    balance,           // موجب = المورد دائن علينا
    is_overdue:       false,
  };
}

// تحديث حالة القسط لو تجاوز تاريخ الاستحقاق
function syncInstallmentStatuses(db_run) {
  db_run(`
    UPDATE payment_installments
    SET status = 'overdue'
    WHERE status = 'pending'
      AND due_date < date('now')
      AND paid_amount < amount
  `);
}

module.exports = { getSupplierBalance, syncInstallmentStatuses };
