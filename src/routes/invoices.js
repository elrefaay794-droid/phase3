// routes/invoices.js
const express    = require('express');
const router     = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');
const { sendInvoiceTelegramNotification }    = require('../utils/telegram');

router.use(authenticate);

function genInvoiceNumber() {
  const r = get(`SELECT COUNT(*) as c FROM invoices`);
  return `INV-${String((r?.c||0)+1).padStart(5,'0')}`;
}

function calcInvoiceTotals(items, discPct, discAmt, taxPct) {
  let subtotal = 0;
  const enriched = items.map(item => {
    const gross     = item.quantity * item.unit_price;
    const lineDisc  = gross * (item.discount_pct||0) / 100;
    const lineTotal = gross - lineDisc;
    subtotal += lineTotal;
    return { ...item, line_total: lineTotal };
  });
  const discountAmount = discAmt || (subtotal * (discPct||0) / 100);
  const afterDisc      = subtotal - discountAmount;
  const taxAmount      = afterDisc * (taxPct||0) / 100;
  const total           = afterDisc + taxAmount;
  return { enriched, subtotal, discountAmount, taxAmount, total };
}

// ── يتحقق من كل بند: منتج + كمية صحيحة + مخزن محدد + صلاحية المستخدم على المخزن
//    + توفر الكمية المطلوبة فعلياً في المخزن المختار. بيرجع رسالة خطأ واضحة أول
//    ما يلاقي مشكلة، عشان المستخدم يعرف بالظبط أنهي بند وأنهي مخزن السبب. ──
function validateItemLocations(items, user) {
  const allowed = getAllowedLocationIds(user);
  for (const item of items) {
    if (!item.product_id || !item.quantity || item.quantity <= 0)
      return { error: 'كل بند يجب أن يحتوي على منتج وكمية صحيحة' };
    if (!item.location_id)
      return { error: 'يجب تحديد المخزن لكل بند في الفاتورة' };
    if (allowed && !allowed.includes(Number(item.location_id))) {
      const p = get(`SELECT name FROM products WHERE id=?`,[item.product_id]);
      return { error: `ليس لديك صلاحية على المخزن المختار للمنتج "${p?.name||''}"` };
    }
    const stock = get(`SELECT quantity FROM inventory WHERE product_id=? AND location_id=?`,[item.product_id, item.location_id]);
    const qty   = stock?.quantity || 0;
    if (qty < item.quantity) {
      const p = get(`SELECT name FROM products WHERE id=?`,[item.product_id]);
      const l = get(`SELECT name FROM locations WHERE id=?`,[item.location_id]);
      return { error: `المخزون المتوفر من "${p?.name}" في "${l?.name||'المخزن المختار'}" هو ${qty} فقط` };
    }
  }
  return null;
}

// ── لو كل بنود الفاتورة من نفس المخزن، نخزّن المخزن ده على الفاتورة نفسها (للطباعة
//    والعرض السريع). لو البنود موزّعة على أكتر من مخزن، الفاتورة بتتسجل من غير
//    مخزن موحّد (location_id = null) والمرجع الحقيقي بيفضل على كل بند لوحده. ──
function resolveHeaderLocationId(items) {
  const ids = [...new Set(items.map(i => Number(i.location_id)))];
  return ids.length === 1 ? ids[0] : null;
}

// ── لو نوع الدفع "تقسيط"، بنتحقق إن جدول الأقساط منطقي فعلاً قبل ما نحفظه:
//    موجود، كل قسط فيه مبلغ فعلي (مش صفر)، ومجموع الأقساط قريب من إجمالي الفاتورة.
//    ده خط دفاع تاني (defense-in-depth) مستقل تمامًا عن الواجهة — حتى لو حصل باج
//    تاني في المتصفح يبعت أرقام غلط أو أصفار، السيرفر مش هيقبلها بصمت زي ما كان
//    بيحصل قبل كده (باج فعلي اتصلح: توليد الأقساط في الواجهة كان بيقرأ الإجمالي من
//    نص متنسّق محلياً بدل رقم خام، وعلى بعض المتصفحات ده كان بيرجّع صفر). ──
function validateInstallments(installments, total, paymentType) {
  if (paymentType !== 'installment') return null;
  if (!Array.isArray(installments) || installments.length === 0)
    return { error: 'نوع الدفع تقسيط، لازم تحدد جدول أقساط' };
  for (const inst of installments) {
    if (!inst.amount || inst.amount <= 0 || !inst.due_date)
      return { error: 'كل قسط لازم يكون له مبلغ صحيح أكبر من صفر وتاريخ استحقاق' };
  }
  const sum = installments.reduce((s,i) => s + Number(i.amount||0), 0);
  const tolerance = Math.max(1, total * 0.01); // هامش بسيط لفروق التقريب (1 ج.م أو 1% أيهما أكبر)
  if (Math.abs(sum - total) > tolerance)
    return { error: `مجموع الأقساط (${sum.toFixed(2)} ج.م) لا يطابق إجمالي الفاتورة (${total.toFixed(2)} ج.م) — تأكد من جدول الأقساط` };
  return null;
}

// ── GET /api/invoices ──
router.get('/', (req, res) => {
  const { customer_id, status, payment_type, from_date, to_date, search } = req.query;
  let sql = `
    SELECT inv.*, c.name as customer_name, c.code as customer_code, c.type as customer_type,
           l.name as location_name, u.full_name as created_by
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    LEFT JOIN users u ON inv.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND inv.customer_id=?`;   params.push(customer_id); }
  if (status)      { sql += ` AND inv.status=?`;         params.push(status); }
  if (payment_type){ sql += ` AND inv.payment_type=?`;   params.push(payment_type); }
  if (from_date)   { sql += ` AND inv.invoice_date>=?`;  params.push(from_date); }
  if (to_date)     { sql += ` AND inv.invoice_date<=?`;  params.push(to_date); }
  if (search)      { sql += ` AND (inv.invoice_number LIKE ? OR c.name LIKE ?)`; const t=`%${search}%`; params.push(t,t); }
  sql += ` ORDER BY inv.created_at DESC LIMIT 500`;

  const invoices = all(sql, params).map(inv => ({
    ...inv,
    balance_due: parseFloat((inv.total - inv.paid_amount).toFixed(2)),
  }));
  res.json({ invoices, count: invoices.length });
});

// ── GET /api/invoices/summary ── (لوحة التحكم)
router.get('/summary', (req, res) => {
  const today  = new Date().toISOString().split('T')[0];
  const month  = today.substring(0,7);
  const stats  = get(`
    SELECT
      COUNT(*) as total_count,
      COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN total ELSE 0 END),0) as total_revenue,
      COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN paid_amount ELSE 0 END),0) as total_collected,
      COALESCE(SUM(CASE WHEN invoice_date LIKE ? AND status NOT IN ('draft','cancelled') THEN total ELSE 0 END),0) as month_revenue,
      COUNT(CASE WHEN status='partial' OR (status='confirmed' AND paid_amount < total) THEN 1 END) as outstanding_count
    FROM invoices`, [month+'%']);

  res.json(stats);
});

// ── GET /api/invoices/:id ──
router.get('/:id', (req, res) => {
  const inv = get(`
    SELECT inv.*, c.name as customer_name, c.code as customer_code,
           c.type as customer_type, c.phone as customer_phone,
           c.address as customer_address, c.tax_number as customer_tax,
           l.name as location_name, u.full_name as created_by
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    LEFT JOIN users u ON inv.user_id = u.id
    WHERE inv.id=?`, [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

  const items    = all(`
    SELECT ii.*, p.name as product_name, p.sku, p.barcode, p.unit, l.name as location_name
    FROM invoice_items ii
    JOIN products p ON ii.product_id=p.id
    LEFT JOIN locations l ON ii.location_id=l.id
    WHERE ii.invoice_id=?`,[inv.id]);
  const payments = all(`SELECT * FROM customer_payments WHERE invoice_id=? ORDER BY payment_date ASC`,[inv.id]);
  const installs = all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number ASC`,[inv.id]);
  const returns_ = all(`SELECT * FROM sales_returns WHERE invoice_id=?`,[inv.id]);

  res.json({
    invoice: { ...inv, balance_due: inv.total - inv.paid_amount },
    items, payments, installments: installs, returns: returns_,
  });
});

// ── POST /api/invoices ──
router.post('/', authorize('admin','manager','sales'), (req, res) => {
  const { customer_id, location_id, invoice_date, due_date, payment_type,
          discount_pct, discount_amount, tax_pct, notes, notes_en,
          items, installments } = req.body;

  if (!customer_id)  return res.status(400).json({ error: 'العميل مطلوب' });
  if (!items?.length) return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });

  const customer = get(`SELECT * FROM customers WHERE id=? AND is_active=1`,[customer_id]);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود أو غير نشط' });

  // كل بند بيحدد مخزنه بنفسه (دعم البيع من أكتر من مخزن في نفس الفاتورة).
  // لو في بند قديم لسه باعت location_id على مستوى الفاتورة بس من غير ما يحددها لكل بند،
  // نطبّقها كقيمة افتراضية على البنود اللي ناقصاها، للتوافق مع نسخ قديمة من الواجهة.
  const itemsWithLocation = items.map(it => ({ ...it, location_id: it.location_id || location_id || null }));

  const stockError = validateItemLocations(itemsWithLocation, req.user);
  if (stockError) return res.status(400).json(stockError);

  const effectiveDiscPct = discount_pct ?? customer.discount_pct ?? 0;
  const { enriched, subtotal, discountAmount, taxAmount, total } =
    calcInvoiceTotals(itemsWithLocation, effectiveDiscPct, discount_amount, tax_pct);
  const headerLocationId = resolveHeaderLocationId(itemsWithLocation);

  const installError = validateInstallments(installments, total, payment_type);
  if (installError) return res.status(400).json(installError);

  const invoiceId = transaction(() => {
    const invoiceNumber = genInvoiceNumber();
    const id = insert(`
      INSERT INTO invoices
      (invoice_number,customer_id,location_id,invoice_date,due_date,status,payment_type,
       subtotal,discount_pct,discount_amount,tax_pct,tax_amount,total,paid_amount,notes,notes_en,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [invoiceNumber, customer_id, headerLocationId,
       invoice_date||new Date().toISOString().split('T')[0],
       due_date||null, 'draft', payment_type||'cash',
       subtotal, effectiveDiscPct, discountAmount, tax_pct||0, taxAmount, total,
       notes||null, notes_en||null, req.user.id]
    );

    for (const item of enriched) {
      insert(`INSERT INTO invoice_items (invoice_id,product_id,quantity,unit_price,discount_pct,line_total,location_id) VALUES (?,?,?,?,?,?,?)`,
        [id, item.product_id, item.quantity, item.unit_price, item.discount_pct||0, item.line_total, item.location_id]);
    }

    // جدول الأقساط إن وُجد
    if (Array.isArray(installments) && installments.length > 0) {
      installments.forEach((inst,idx) => {
        insert(`INSERT INTO customer_installments (invoice_id,customer_id,installment_number,amount,due_date,notes) VALUES (?,?,?,?,?,?)`,
          [id, customer_id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      });
    }

    return id;
  });

  logAction(req.user.id,'create','invoice',invoiceId,{ customer_id, total });

  // إرسال إشعار الفاتورة الجديدة إلى تيليجرام (لا يوقف الرد لو فشل الإرسال)
  const invForMsg = get(`
    SELECT inv.*, c.name as customer_name, l.name as location_name
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    WHERE inv.id = ?`, [invoiceId]);
  const itemsForMsg = all(`SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON ii.product_id=p.id WHERE ii.invoice_id=?`, [invoiceId]);
  const installmentsForMsg = all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number ASC`, [invoiceId]);
  sendInvoiceTelegramNotification(invForMsg, itemsForMsg, installmentsForMsg, 'draft');

  res.status(201).json({ message:'تم إنشاء الفاتورة بنجاح', invoice: get(`SELECT * FROM invoices WHERE id=?`,[invoiceId]) });
});

// ── POST /api/invoices/:id/confirm ── (تأكيد الفاتورة = يخصم المخزون)
router.post('/:id/confirm', authorize('admin','manager','sales'), (req, res) => {
  const inv = get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'يمكن تأكيد المسودات فقط' });
  const items = all(`SELECT * FROM invoice_items WHERE invoice_id=?`,[inv.id]);
  if (items.some(it => !it.location_id))
    return res.status(400).json({ error: 'يوجد بند في الفاتورة بدون مخزن محدد — يجب تعديل الفاتورة وتحديد مخزن لكل بند قبل التأكيد' });

  transaction(() => {
    for (const item of items) {
      const stock = get(`SELECT * FROM inventory WHERE product_id=? AND location_id=?`,[item.product_id, item.location_id]);
      const before = stock?.quantity || 0;
      const after  = before - item.quantity;
      if (after < 0) {
        const p = get(`SELECT name FROM products WHERE id=?`,[item.product_id]);
        const l = get(`SELECT name FROM locations WHERE id=?`,[item.location_id]);
        throw new Error(`المخزون غير كافٍ للمنتج "${p?.name}" في "${l?.name||'المخزن'}" — المتوفر: ${before}`);
      }
      run(`UPDATE inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`,
        [after, item.product_id, item.location_id]);
      insert(`INSERT INTO stock_movements
        (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,reference_type,reference_id,notes,user_id)
        VALUES (?,?,'out',?,?,?,'invoice',?,?,?)`,
        [item.product_id, item.location_id, -item.quantity, before, after, inv.id, `فاتورة مبيعات — ${inv.invoice_number}`, req.user.id]);
    }
    run(`UPDATE invoices SET status=CASE WHEN payment_type='cash' THEN 'confirmed' ELSE 'confirmed' END, updated_at=datetime('now') WHERE id=?`,[inv.id]);
  });

  logAction(req.user.id,'confirm','invoice',inv.id,null);

  // إرسال إشعار تأكيد الفاتورة إلى تيليجرام
  const confirmedInv = get(`
    SELECT inv.*, c.name as customer_name, l.name as location_name
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    WHERE inv.id = ?`, [inv.id]);
  const confirmedItems = all(`SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON ii.product_id=p.id WHERE ii.invoice_id=?`, [inv.id]);
  const confirmedInstallments = all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number ASC`, [inv.id]);
  sendInvoiceTelegramNotification(confirmedInv, confirmedItems, confirmedInstallments, 'confirmed');

  res.json({ message:'تم تأكيد الفاتورة وتحديث المخزون', invoice: get(`SELECT * FROM invoices WHERE id=?`,[inv.id]) });
});

// ── PUT /api/invoices/:id ── (تعديل فاتورة لسه مسودة فقط — بيستبدل البنود بالكامل)
router.put('/:id', authorize('admin','manager','sales'), (req, res) => {
  const inv = get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'لا يمكن تعديل فاتورة بعد تأكيدها — يمكن تعديل المسودات فقط' });

  const { customer_id, location_id, invoice_date, due_date, payment_type,
          discount_pct, discount_amount, tax_pct, notes, notes_en,
          items, installments } = req.body;

  if (!customer_id)  return res.status(400).json({ error: 'العميل مطلوب' });
  if (!items?.length) return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });

  const customer = get(`SELECT * FROM customers WHERE id=? AND is_active=1`,[customer_id]);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود أو غير نشط' });

  const itemsWithLocation = items.map(it => ({ ...it, location_id: it.location_id || location_id || null }));
  const stockError = validateItemLocations(itemsWithLocation, req.user);
  if (stockError) return res.status(400).json(stockError);

  const effectiveDiscPct = discount_pct ?? customer.discount_pct ?? 0;
  const { enriched, subtotal, discountAmount, taxAmount, total } =
    calcInvoiceTotals(itemsWithLocation, effectiveDiscPct, discount_amount, tax_pct);
  const headerLocationId = resolveHeaderLocationId(itemsWithLocation);

  const installError = validateInstallments(installments, total, payment_type);
  if (installError) return res.status(400).json(installError);

  transaction(() => {
    run(`
      UPDATE invoices SET
        customer_id=?, location_id=?, invoice_date=?, due_date=?, payment_type=?,
        subtotal=?, discount_pct=?, discount_amount=?, tax_pct=?, tax_amount=?, total=?,
        notes=?, notes_en=?, updated_at=datetime('now')
      WHERE id=?`,
      [customer_id, headerLocationId, invoice_date||inv.invoice_date, due_date||null, payment_type||'cash',
       subtotal, effectiveDiscPct, discountAmount, tax_pct||0, taxAmount, total,
       notes||null, notes_en||null, inv.id]
    );

    // استبدال البنود بالكامل (الفاتورة لسه مسودة، لا يوجد مخزون اتخصم بعد، فالاستبدال آمن)
    run(`DELETE FROM invoice_items WHERE invoice_id=?`,[inv.id]);
    for (const item of enriched) {
      insert(`INSERT INTO invoice_items (invoice_id,product_id,quantity,unit_price,discount_pct,line_total,location_id) VALUES (?,?,?,?,?,?,?)`,
        [inv.id, item.product_id, item.quantity, item.unit_price, item.discount_pct||0, item.line_total, item.location_id]);
    }

    // استبدال جدول الأقساط بالكامل لو نوع الدفع تقسيط
    run(`DELETE FROM customer_installments WHERE invoice_id=?`,[inv.id]);
    if (Array.isArray(installments) && installments.length > 0) {
      installments.forEach((inst,idx) => {
        insert(`INSERT INTO customer_installments (invoice_id,customer_id,installment_number,amount,due_date,notes) VALUES (?,?,?,?,?,?)`,
          [inv.id, customer_id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      });
    }
  });

  logAction(req.user.id,'update','invoice',inv.id,{ customer_id, total });

  res.json({ message:'تم حفظ تعديلات الفاتورة', invoice: get(`SELECT * FROM invoices WHERE id=?`,[inv.id]) });
});

// ── POST /api/invoices/:id/cancel ── (إلغاء فاتورة لسه مسودة — لا يوجد مخزون لرجوعه لأن المسودة لا تخصم المخزون)
router.post('/:id/cancel', authorize('admin','manager','sales'), (req, res) => {
  const inv = get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'لا يمكن إلغاء فاتورة بعد تأكيدها من هنا — استخدم المردودات بدلاً من ذلك' });

  run(`UPDATE invoices SET status='cancelled', updated_at=datetime('now') WHERE id=?`,[inv.id]);
  logAction(req.user.id,'cancel','invoice',inv.id,null);

  res.json({ message:'تم إلغاء الفاتورة', invoice: get(`SELECT * FROM invoices WHERE id=?`,[inv.id]) });
});

// ── PUT /api/invoices/:id/status ──
router.put('/:id/status', authorize('admin','manager'), (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft','confirmed','partial','paid','cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  const inv = get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

  run(`UPDATE invoices SET status=?, updated_at=datetime('now') WHERE id=?`,[status, req.params.id]);
  res.json({ message:'تم تحديث الحالة' });
});

module.exports = router;