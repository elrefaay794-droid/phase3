// routes/salesReturns.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');

router.use(authenticate);

function genReturnNumber() {
  const r = get(`SELECT COUNT(*) as c FROM sales_returns`);
  return `RTN-${String((r?.c||0)+1).padStart(5,'0')}`;
}

// GET /api/sales-returns
router.get('/', (req, res) => {
  const { customer_id, invoice_id, status } = req.query;
  let sql = `
    SELECT sr.*, c.name as customer_name, inv.invoice_number, u.full_name as created_by
    FROM sales_returns sr
    JOIN customers c ON sr.customer_id=c.id
    JOIN invoices inv ON sr.invoice_id=inv.id
    LEFT JOIN users u ON sr.user_id=u.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND sr.customer_id=?`; params.push(customer_id); }
  if (invoice_id)  { sql += ` AND sr.invoice_id=?`;  params.push(invoice_id); }
  if (status)      { sql += ` AND sr.status=?`;      params.push(status); }
  sql += ` ORDER BY sr.created_at DESC LIMIT 200`;

  const returns_ = all(sql, params);
  res.json({ returns: returns_, count: returns_.length });
});

// GET /api/sales-returns/:id
router.get('/:id', (req, res) => {
  const r = get(`
    SELECT sr.*, c.name as customer_name, inv.invoice_number, l.name as location_name
    FROM sales_returns sr
    JOIN customers c ON sr.customer_id=c.id
    JOIN invoices inv ON sr.invoice_id=inv.id
    JOIN locations l ON sr.location_id=l.id
    WHERE sr.id=?`,[req.params.id]);
  if (!r) return res.status(404).json({ error: 'المرتجع غير موجود' });

  const items = all(`
    SELECT sri.*, p.name as product_name, p.sku, p.unit
    FROM sales_return_items sri JOIN products p ON sri.product_id=p.id
    WHERE sri.return_id=?`,[r.id]);

  res.json({ return: r, items });
});

// POST /api/sales-returns — إنشاء مرتجع (يحتاج موافقة ثم إكمال)
router.post('/', authorize('admin','manager','sales'), (req, res) => {
  const { invoice_id, location_id, return_date, return_type, reason, notes, items } = req.body;

  if (!invoice_id || !location_id)
    return res.status(400).json({ error: 'الفاتورة والموقع مطلوبان' });
  if (!items?.length)
    return res.status(400).json({ error: 'يجب تحديد منتج واحد على الأقل' });

  const inv = get(`SELECT * FROM invoices WHERE id=? AND status NOT IN ('draft','cancelled')`,[invoice_id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة أو لا يمكن إرجاعها' });

  // التحقق من الكميات المتوفرة للإرجاع
  let totalRefund = 0;
  for (const item of items) {
    const invItem = get(`SELECT * FROM invoice_items WHERE id=? AND invoice_id=?`,[item.invoice_item_id, invoice_id]);
    if (!invItem) return res.status(400).json({ error: `البند رقم ${item.invoice_item_id} غير موجود في الفاتورة` });
    const alreadyReturned = invItem.returned_qty || 0;
    const maxReturn = invItem.quantity - alreadyReturned;
    if (item.quantity > maxReturn)
      return res.status(400).json({ error: `الكمية المتاحة للإرجاع من "${get(`SELECT name FROM products WHERE id=?`,[invItem.product_id])?.name}" هي ${maxReturn} فقط` });
    totalRefund += item.quantity * invItem.unit_price;
  }

  const returnId = transaction(() => {
    const returnNumber = genReturnNumber();
    const id = insert(`
      INSERT INTO sales_returns
      (return_number,invoice_id,customer_id,location_id,return_date,return_type,status,total_refund,reason,notes,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [returnNumber, invoice_id, inv.customer_id, location_id,
       return_date||new Date().toISOString().split('T')[0],
       return_type||'refund', 'pending', totalRefund, reason||null, notes||null, req.user.id]
    );

    for (const item of items) {
      const invItem = get(`SELECT * FROM invoice_items WHERE id=?`,[item.invoice_item_id]);
      insert(`INSERT INTO sales_return_items (return_id,invoice_item_id,product_id,quantity,unit_price,condition,restock) VALUES (?,?,?,?,?,?,?)`,
        [id, item.invoice_item_id, invItem.product_id, item.quantity, invItem.unit_price,
         item.condition||'good', item.restock!==false?1:0]);
    }
    return id;
  });

  logAction(req.user.id,'create','sales_return',returnId,{ invoice_id, total_refund: totalRefund });
  res.status(201).json({ message:'تم إنشاء طلب الإرجاع', return: get(`SELECT * FROM sales_returns WHERE id=?`,[returnId]) });
});

// POST /api/sales-returns/:id/approve — موافقة + تحديث المخزون + استرداد المبلغ
router.post('/:id/approve', authorize('admin','manager'), (req, res) => {
  const ret = get(`SELECT * FROM sales_returns WHERE id=?`,[req.params.id]);
  if (!ret) return res.status(404).json({ error: 'المرتجع غير موجود' });
  if (ret.status !== 'pending') return res.status(400).json({ error: 'يمكن الموافقة على المرتجعات المعلقة فقط' });

  const items = all(`SELECT * FROM sales_return_items WHERE return_id=?`,[ret.id]);

  transaction(() => {
    for (const item of items) {
      // تحديث returned_qty في بند الفاتورة
      run(`UPDATE invoice_items SET returned_qty=returned_qty+? WHERE id=?`,[item.quantity, item.invoice_item_id]);

      // إعادة المخزون إن كان الشرط restock=true
      if (item.restock) {
        const stock  = get(`SELECT * FROM inventory WHERE product_id=? AND location_id=?`,[item.product_id, ret.location_id]);
        const before = stock?.quantity || 0;
        const after  = before + item.quantity;
        if (stock) {
          run(`UPDATE inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`,
            [after, item.product_id, ret.location_id]);
        } else {
          insert(`INSERT INTO inventory (product_id,location_id,quantity) VALUES (?,?,?)`,
            [item.product_id, ret.location_id, after]);
        }
        insert(`INSERT INTO stock_movements
          (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,reference_type,reference_id,notes,user_id)
          VALUES (?,?,'in',?,?,?,'sales_return',?,?,?)`,
          [item.product_id, ret.location_id, item.quantity, before, after, ret.id, `مرتجع مبيعات — ${ret.return_number}`, req.user.id]);
      }
    }

    // تحديث paid_amount في الفاتورة (طرح قيمة المرتجع من المدفوع)
    if (ret.return_type === 'refund') {
      const inv = get(`SELECT * FROM invoices WHERE id=?`,[ret.invoice_id]);
      if (inv) {
        const newPaid  = Math.max(0, inv.paid_amount - ret.total_refund);
        const newTotal = inv.total - ret.total_refund;
        const newStatus = newTotal <= 0 ? 'refunded'
                        : newPaid >= newTotal ? 'paid'
                        : newPaid > 0 ? 'partial' : 'confirmed';
        run(`UPDATE invoices SET paid_amount=?, total=?, status=?, updated_at=datetime('now') WHERE id=?`,
          [newPaid, newTotal, newStatus, ret.invoice_id]);
      }
    }

    run(`UPDATE sales_returns SET status='completed', updated_at=datetime('now') WHERE id=?`,[ret.id]);
  });

  logAction(req.user.id,'approve','sales_return',ret.id,null);
  res.json({ message:'تم إتمام الإرجاع وتحديث المخزون' });
});

// PUT /api/sales-returns/:id/reject
router.put('/:id/reject', authorize('admin','manager'), (req, res) => {
  const { reason } = req.body;
  const ret = get(`SELECT * FROM sales_returns WHERE id=?`,[req.params.id]);
  if (!ret || ret.status !== 'pending') return res.status(400).json({ error: 'لا يمكن رفض هذا المرتجع' });
  run(`UPDATE sales_returns SET status='rejected', notes=COALESCE(?,notes) WHERE id=?`,[reason||null, req.params.id]);
  res.json({ message:'تم رفض المرتجع' });
});

module.exports = router;