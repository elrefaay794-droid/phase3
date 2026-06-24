// routes/suppliers.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getSupplierBalance }                 = require('../utils/supplierLedger');

router.use(authenticate);

// ── توليد كود مورد تلقائي ──
function genSupplierCode() {
  const r = get(`SELECT COUNT(*) as c FROM suppliers`);
  return `SUP-${String((r?.c || 0) + 1).padStart(4,'0')}`;
}

// ── GET /api/suppliers ──
router.get('/', (req, res) => {
  const { search, is_active } = req.query;
  let sql = `SELECT * FROM suppliers WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ` AND (name LIKE ? OR code LIKE ? OR phone LIKE ? OR contact_person LIKE ?)`;
    const t = `%${search}%`;
    params.push(t,t,t,t);
  }
  if (is_active !== undefined)
    sql += ` AND is_active = ${is_active === 'true' || is_active === '1' ? 1 : 0}`;
  sql += ` ORDER BY name ASC`;

  const suppliers = all(sql, params).map(s => ({
    ...s,
    is_active: !!s.is_active,
    balance: getSupplierBalance(s.id),
  }));
  res.json({ suppliers, count: suppliers.length });
});

// ── GET /api/suppliers/:id ──
router.get('/:id', (req, res) => {
  const s = get(`SELECT * FROM suppliers WHERE id = ?`, [req.params.id]);
  if (!s) return res.status(404).json({ error: 'المورد غير موجود' });

  const relations = all(`
    SELECT sr.*, sup.name as related_name, sup.code as related_code, sup.phone as related_phone
    FROM supplier_relations sr
    JOIN suppliers sup ON sr.related_supplier_id = sup.id
    WHERE sr.supplier_id = ?
  `, [s.id]);

  const recentPOs = all(`
    SELECT id, po_number, status, total, paid_amount, order_date
    FROM purchase_orders WHERE supplier_id = ?
    ORDER BY created_at DESC LIMIT 10
  `, [s.id]);

  res.json({
    supplier: { ...s, is_active: !!s.is_active },
    balance: getSupplierBalance(s.id),
    relations,
    recent_orders: recentPOs,
  });
});

// ── POST /api/suppliers ──
router.post('/', authorize('admin','manager'), (req, res) => {
  const {
    name, name_en, type, phone, phone2, email, address, city, country,
    tax_number, commercial_register, contact_person, contact_phone,
    payment_terms, credit_limit, opening_balance, notes, code,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'اسم المورد مطلوب' });
  const supplierCode = code?.trim() || genSupplierCode();
  if (get(`SELECT id FROM suppliers WHERE code = ?`, [supplierCode]))
    return res.status(409).json({ error: 'الكود مستخدم بالفعل' });

  const newId = insert(`
    INSERT INTO suppliers
    (code,name,name_en,type,phone,phone2,email,address,city,country,
     tax_number,commercial_register,contact_person,contact_phone,
     payment_terms,credit_limit,opening_balance,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [supplierCode, name, name_en||null, type||'company',
     phone||null, phone2||null, email||null, address||null, city||null, country||'مصر',
     tax_number||null, commercial_register||null,
     contact_person||null, contact_phone||null,
     payment_terms||30, credit_limit||0, opening_balance||0, notes||null]
  );

  logAction(req.user.id, 'create', 'supplier', newId, { name, code: supplierCode });
  res.status(201).json({ message: 'تم إنشاء المورد بنجاح', supplier: get(`SELECT * FROM suppliers WHERE id=?`,[newId]) });
});

// ── PUT /api/suppliers/:id ──
router.put('/:id', authorize('admin','manager'), (req, res) => {
  const { id } = req.params;
  const s = get(`SELECT * FROM suppliers WHERE id=?`,[id]);
  if (!s) return res.status(404).json({ error: 'المورد غير موجود' });

  const f = req.body;
  run(`UPDATE suppliers SET
    name=COALESCE(?,name), name_en=COALESCE(?,name_en), type=COALESCE(?,type),
    phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
    address=COALESCE(?,address), city=COALESCE(?,city), country=COALESCE(?,country),
    tax_number=COALESCE(?,tax_number), commercial_register=COALESCE(?,commercial_register),
    contact_person=COALESCE(?,contact_person), contact_phone=COALESCE(?,contact_phone),
    payment_terms=COALESCE(?,payment_terms), credit_limit=COALESCE(?,credit_limit),
    opening_balance=COALESCE(?,opening_balance), notes=COALESCE(?,notes),
    is_active=COALESCE(?,is_active), updated_at=datetime('now')
    WHERE id=?`,
    [f.name??null, f.name_en??null, f.type??null,
     f.phone??null, f.phone2??null, f.email??null,
     f.address??null, f.city??null, f.country??null,
     f.tax_number??null, f.commercial_register??null,
     f.contact_person??null, f.contact_phone??null,
     f.payment_terms??null, f.credit_limit??null,
     f.opening_balance??null, f.notes??null,
     f.is_active !== undefined ? (f.is_active ? 1 : 0) : null,
     id]
  );

  logAction(req.user.id, 'update', 'supplier', id, req.body);
  res.json({ supplier: get(`SELECT * FROM suppliers WHERE id=?`,[id]) });
});

// ── PUT /api/suppliers/:id/relations ──
router.put('/:id/relations', authorize('admin','manager'), (req, res) => {
  const { id } = req.params;
  const { related_ids } = req.body; // مصفوفة IDs الموردين المرتبطين
  if (!get(`SELECT id FROM suppliers WHERE id=?`,[id]))
    return res.status(404).json({ error: 'المورد غير موجود' });

  run(`DELETE FROM supplier_relations WHERE supplier_id=?`, [id]);
  if (Array.isArray(related_ids)) {
    for (const rid of related_ids) {
      if (Number(rid) !== Number(id)) {
        insert(`INSERT OR IGNORE INTO supplier_relations (supplier_id, related_supplier_id) VALUES (?,?)`, [id, rid]);
      }
    }
  }
  res.json({ message: 'تم تحديث العلاقات بنجاح' });
});

// ── GET /api/suppliers/:id/statement — كشف حساب كامل ──
router.get('/:id/statement', (req, res) => {
  const { id } = req.params;
  const s = get(`SELECT * FROM suppliers WHERE id=?`,[id]);
  if (!s) return res.status(404).json({ error: 'المورد غير موجود' });

  const orders   = all(`SELECT id,po_number,order_date,total,paid_amount,status FROM purchase_orders WHERE supplier_id=? ORDER BY order_date ASC`, [id]);
  const payments = all(`SELECT id,payment_number,payment_date,amount,payment_method,reference FROM supplier_payments WHERE supplier_id=? ORDER BY payment_date ASC`, [id]);
  const installs = all(`SELECT * FROM payment_installments WHERE supplier_id=? ORDER BY due_date ASC`, [id]);

  res.json({
    supplier: s,
    balance: getSupplierBalance(id),
    orders, payments,
    installments: installs,
  });
});

// ── POST /api/suppliers/import — استيراد من Excel ──
const tmpDir = path.join(__dirname,'../uploads/temp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir,{recursive:true});
const upload = multer({ dest: tmpDir, limits: { fileSize: 10*1024*1024 } });

router.post('/import', authorize('admin','manager'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'يرجى رفع ملف Excel' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    fs.unlink(req.file.path, ()=>{});

    const results = { success: [], errors: [] };
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      try {
        const name = String(row.name || row['اسم المورد'] || '').trim();
        if (!name) { results.errors.push({ row: rowNum, error: 'اسم المورد مطلوب' }); return; }
        const code = String(row.code || row['الكود'] || '').trim() || genSupplierCode();
        if (get(`SELECT id FROM suppliers WHERE code=?`,[code])) {
          results.errors.push({ row: rowNum, error: `الكود ${code} مستخدم` }); return;
        }
        const newId = insert(`
          INSERT INTO suppliers (code,name,phone,email,address,city,contact_person,contact_phone,opening_balance,payment_terms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [code, name,
           String(row.phone||row['الهاتف']||'').trim()||null,
           String(row.email||row['البريد']||'').trim()||null,
           String(row.address||row['العنوان']||'').trim()||null,
           String(row.city||row['المدينة']||'').trim()||null,
           String(row.contact_person||row['المسؤول']||'').trim()||null,
           String(row.contact_phone||row['هاتف المسؤول']||'').trim()||null,
           parseFloat(row.opening_balance||row['الرصيد الافتتاحي']||0)||0,
           parseInt(row.payment_terms||row['أيام السداد']||30)||30,
          ]);
        results.success.push({ row: rowNum, id: newId, code, name });
      } catch(e) { results.errors.push({ row: rowNum, error: e.message }); }
    });

    logAction(req.user.id, 'bulk_import', 'supplier', null, { imported: results.success.length });
    res.json({
      message: `تم استيراد ${results.success.length} مورد من أصل ${rows.length}`,
      imported: results.success.length, failed: results.errors.length,
      success_details: results.success, error_details: results.errors,
    });
  } catch(e) {
    if (req.file) fs.unlink(req.file.path,()=>{});
    res.status(500).json({ error: 'خطأ في قراءة الملف: ' + e.message });
  }
});

// ── GET /api/suppliers/import/template ──
router.get('/import/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['name','code','phone','email','address','city','contact_person','contact_phone','opening_balance','payment_terms'],
    ['شركة النور للإضاءة','','01012345678','info@alnour.com','القاهرة - مصر الجديدة','القاهرة','محمد أحمد','01098765432',5000,30],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'الموردون');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename="suppliers_template.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
