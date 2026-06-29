// routes/customers.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction }               = require('../utils/auditLog');
const { getCustomerBalance }      = require('../utils/customerLedger');

router.use(authenticate);

function genCustomerCode() {
  const r = get(`SELECT COUNT(*) as c FROM customers`);
  return `CUS-${String((r?.c||0)+1).padStart(4,'0')}`;
}

// GET /api/customers
router.get('/', (req, res) => {
  const { search, type, is_active } = req.query;
  let sql = `SELECT * FROM customers WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ` AND (name LIKE ? OR code LIKE ? OR phone LIKE ?)`;
    const t = `%${search}%`; params.push(t,t,t);
  }
  if (type)      { sql += ` AND type=?`;      params.push(type); }
  if (is_active !== undefined)
    sql += ` AND is_active=${is_active==='true'||is_active==='1'?1:0}`;
  sql += ` ORDER BY name ASC`;

  const customers = all(sql,params).map(c => ({
    ...c, is_active: !!c.is_active,
    balance: getCustomerBalance(c.id),
  }));
  res.json({ customers, count: customers.length });
});

// GET /api/customers/:id
router.get('/:id', (req, res) => {
  const c = get(`SELECT * FROM customers WHERE id=?`,[req.params.id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const recentInvoices = all(`
    SELECT id,invoice_number,invoice_date,total,paid_amount,status
    FROM invoices WHERE customer_id=?
    ORDER BY created_at DESC LIMIT 10
  `,[c.id]);

  res.json({
    customer: { ...c, is_active: !!c.is_active },
    balance: getCustomerBalance(c.id),
    recent_invoices: recentInvoices,
  });
});

// GET /api/customers/:id/statement
router.get('/:id/statement', (req, res) => {
  const c = get(`SELECT * FROM customers WHERE id=?`,[req.params.id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const invoices  = all(`SELECT id,invoice_number,invoice_date,total,paid_amount,status FROM invoices WHERE customer_id=? ORDER BY invoice_date ASC`,[c.id]);
  const payments  = all(`SELECT id,payment_number,payment_date,amount,payment_method FROM customer_payments WHERE customer_id=? ORDER BY payment_date ASC`,[c.id]);
  const installs  = all(`SELECT * FROM customer_installments WHERE customer_id=? ORDER BY due_date ASC`,[c.id]);
  const returns_  = all(`SELECT id,return_number,return_date,total_refund,status FROM sales_returns WHERE customer_id=? ORDER BY return_date DESC`,[c.id]);

  res.json({
    customer: c,
    balance: getCustomerBalance(c.id),
    invoices, payments, installments: installs, returns: returns_,
  });
});

// POST /api/customers
router.post('/', authorize('admin','manager','sales'), (req, res) => {
  const { name, name_en, type, phone, phone2, email, address, city, country,
          tax_number, contact_person, discount_pct, credit_limit,
          payment_terms, opening_balance, notes, code } = req.body;

  if (!name) return res.status(400).json({ error: 'اسم العميل مطلوب' });
  const custCode = code?.trim() || genCustomerCode();
  if (get(`SELECT id FROM customers WHERE code=?`,[custCode]))
    return res.status(409).json({ error: 'الكود مستخدم بالفعل' });

  const newId = insert(`
    INSERT INTO customers
    (code,name,name_en,type,phone,phone2,email,address,city,country,
     tax_number,contact_person,discount_pct,credit_limit,payment_terms,opening_balance,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [custCode,name,name_en||null,type||'retail',phone||null,phone2||null,
     email||null,address||null,city||null,country||'مصر',
     tax_number||null,contact_person||null,
     parseFloat(discount_pct)||0, parseFloat(credit_limit)||0,
     parseInt(payment_terms)||0, parseFloat(opening_balance)||0, notes||null]
  );

  logAction(req.user.id,'create','customer',newId,{ name, code: custCode });
  res.status(201).json({ customer: get(`SELECT * FROM customers WHERE id=?`,[newId]) });
});

// PUT /api/customers/:id
router.put('/:id', authorize('admin','manager','sales'), (req, res) => {
  const { id } = req.params;
  const c = get(`SELECT * FROM customers WHERE id=?`,[id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const f = req.body;
  run(`UPDATE customers SET
    name=COALESCE(?,name), name_en=COALESCE(?,name_en), type=COALESCE(?,type),
    phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
    address=COALESCE(?,address), city=COALESCE(?,city),
    tax_number=COALESCE(?,tax_number), contact_person=COALESCE(?,contact_person),
    discount_pct=COALESCE(?,discount_pct), credit_limit=COALESCE(?,credit_limit),
    payment_terms=COALESCE(?,payment_terms), opening_balance=COALESCE(?,opening_balance),
    notes=COALESCE(?,notes),
    is_active=COALESCE(?,is_active), updated_at=datetime('now')
    WHERE id=?`,
    [f.name??null, f.name_en??null, f.type??null,
     f.phone??null, f.phone2??null, f.email??null,
     f.address??null, f.city??null,
     f.tax_number??null, f.contact_person??null,
     f.discount_pct!=null?parseFloat(f.discount_pct):null,
     f.credit_limit!=null?parseFloat(f.credit_limit):null,
     f.payment_terms!=null?parseInt(f.payment_terms):null,
     f.opening_balance!=null?parseFloat(f.opening_balance):null,
     f.notes??null,
     f.is_active!=null?(f.is_active?1:0):null, id]
  );

  logAction(req.user.id,'update','customer',id,req.body);
  res.json({ customer: get(`SELECT * FROM customers WHERE id=?`,[id]) });
});

// POST /api/customers/import
const tmpDir = path.join(__dirname,'../uploads/temp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir,{recursive:true});
const upload = multer({ dest: tmpDir, limits:{ fileSize:10*1024*1024 } });

router.post('/import', authorize('admin','manager'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'يرجى رفع ملف Excel' });
  try {
    const wb   = XLSX.readFile(req.file.path);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{ defval:'' });
    fs.unlink(req.file.path,()=>{});

    const results = { success:[], errors:[] };
    rows.forEach((row, i) => {
      const rowNum = i+2;
      try {
        const name = String(row.name||row['اسم العميل']||'').trim();
        if (!name) { results.errors.push({ row:rowNum, error:'اسم العميل مطلوب' }); return; }
        const code = String(row.code||row['الكود']||'').trim() || genCustomerCode();
        if (get(`SELECT id FROM customers WHERE code=?`,[code])) {
          results.errors.push({ row:rowNum, error:`الكود ${code} مستخدم` }); return;
        }
        const newId = insert(`
          INSERT INTO customers (code,name,type,phone,email,address,city,discount_pct,opening_balance,payment_terms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [code, name,
           String(row.type||row['النوع']||'retail').trim(),
           String(row.phone||row['الهاتف']||'').trim()||null,
           String(row.email||row['البريد']||'').trim()||null,
           String(row.address||row['العنوان']||'').trim()||null,
           String(row.city||row['المدينة']||'').trim()||null,
           parseFloat(row.discount_pct||row['نسبة الخصم']||0)||0,
           parseFloat(row.opening_balance||row['الرصيد الافتتاحي']||0)||0,
           parseInt(row.payment_terms||row['أيام السداد']||0)||0,
          ]);
        results.success.push({ row:rowNum, id:newId, code, name });
      } catch(e) { results.errors.push({ row:rowNum, error:e.message }); }
    });

    logAction(req.user.id,'bulk_import','customer',null,{ imported:results.success.length });
    res.json({ message:`تم استيراد ${results.success.length} عميل`, imported:results.success.length, failed:results.errors.length, success_details:results.success, error_details:results.errors });
  } catch(e) {
    if (req.file) fs.unlink(req.file.path,()=>{});
    res.status(500).json({ error:'خطأ في قراءة الملف: '+e.message });
  }
});

// GET /api/customers/import/template
router.get('/import/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['name','code','type','phone','email','address','city','discount_pct','opening_balance','payment_terms'],
    ['محمد أحمد','','retail','01012345678','m@email.com','القاهرة — مدينة نصر','القاهرة',0,0,0],
    ['شركة النجوم','','wholesale','01099999999','','الجيزة','الجيزة',10,5000,30],
  ]);
  XLSX.utils.book_append_sheet(wb,ws,'العملاء');
  const buf = XLSX.write(wb,{ type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename="customers_template.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
