// db/schema.js
const { run, get } = require('./database');

function createSchema() {
  run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'sales', 'warehouse')),
      is_active INTEGER NOT NULL DEFAULT 1,
      can_view_cost_price INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      name_en TEXT,
      category_id INTEGER,
      unit TEXT NOT NULL DEFAULT 'piece' CHECK(unit IN ('piece', 'meter', 'liter', 'kg', 'set')),
      allow_fractional_qty INTEGER NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      min_stock_threshold REAL NOT NULL DEFAULT 0,
      description TEXT,
      image_path TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'warehouse' CHECK(type IN ('warehouse', 'showroom')),
      address TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, location_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('in', 'out', 'transfer_in', 'transfer_out', 'adjustment', 'initial')),
      quantity REAL NOT NULL,
      quantity_before REAL NOT NULL,
      quantity_after REAL NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL UNIQUE,
      from_location_id INTEGER NOT NULL,
      to_location_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'cancelled')),
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (from_location_id) REFERENCES locations(id),
      FOREIGN KEY (to_location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ===================== جدول صلاحيات المواقع لكل مستخدم =====================
  // admin دائماً يشوف كل المواقع (مش محتاج صفوف هنا)
  // غير الـ admin — يشوف فقط المواقع المحددة له في هذا الجدول
  // لو مفيش صفوف للمستخدم هنا: يشوف كل المواقع (fallback للتوافقية)
  run(`
    CREATE TABLE IF NOT EXISTS user_location_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      UNIQUE(user_id, location_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    );
  `);

  run(`CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);`);
  run(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);`);
  run(`CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_inventory_location ON inventory(location_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);`);
  run(`CREATE INDEX IF NOT EXISTS idx_user_loc_perms ON user_location_permissions(user_id);`);

  console.log('✓ تم إنشاء/تحديث مخطط قاعدة البيانات بنجاح');
}

function seedInitialData() {
  const bcrypt = require('bcryptjs');
  const adminExists = get(`SELECT id FROM users WHERE username = 'admin'`);
  if (!adminExists) {
    const passwordHash = bcrypt.hashSync('admin123', 10);
    run(
      `INSERT INTO users (full_name, username, password_hash, role, can_view_cost_price) VALUES (?, ?, ?, ?, ?)`,
      ['مدير النظام', 'admin', passwordHash, 'admin', 1]
    );
    console.log('✓ تم إنشاء مستخدم Admin افتراضي (username: admin / password: admin123)');
  }

  const locationsExist = get(`SELECT id FROM locations LIMIT 1`);
  if (!locationsExist) {
    const defaultLocations = [
      ['المستودع الرئيسي', 'warehouse'],
      ['المستودع الثاني', 'warehouse'],
      ['المستودع الثالث', 'warehouse'],
      ['المستودع الرابع', 'warehouse'],
      ['صالة العرض', 'showroom'],
    ];
    for (const [name, type] of defaultLocations) {
      run(`INSERT INTO locations (name, type) VALUES (?, ?)`, [name, type]);
    }
    console.log('✓ تم إنشاء المواقع الافتراضية (٤ مستودعات + صالة عرض)');
  }

  const categoriesExist = get(`SELECT id FROM categories LIMIT 1`);
  if (!categoriesExist) {
    for (const name of ['نجف كريستال','نجف ديكوري','سبوت لايت LED','كشافات','لمبات','إكسسوارات إضاءة']) {
      run(`INSERT INTO categories (name) VALUES (?)`, [name]);
    }
    console.log('✓ تم إنشاء التصنيفات الافتراضية');
  }
}

module.exports = { createSchema, seedInitialData };

// ═══════════════════════════════════════════════════════
//  المرحلة الثانية — الموردون والمشتريات
// ═══════════════════════════════════════════════════════

function createProcurementSchema() {
  // ─── الموردون ───
  run(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_en TEXT,
      type TEXT NOT NULL DEFAULT 'company' CHECK(type IN ('company','individual')),
      phone TEXT,
      phone2 TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      country TEXT DEFAULT 'مصر',
      tax_number TEXT,
      commercial_register TEXT,
      contact_person TEXT,
      contact_phone TEXT,
      payment_terms INTEGER DEFAULT 30,
      credit_limit REAL DEFAULT 0,
      opening_balance REAL DEFAULT 0,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── علاقات الموردين ذوي الصلة ───
  run(`
    CREATE TABLE IF NOT EXISTS supplier_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      related_supplier_id INTEGER NOT NULL,
      relation_type TEXT DEFAULT 'related',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(supplier_id, related_supplier_id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
      FOREIGN KEY (related_supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );
  `);

  // ─── أوامر الشراء (Purchase Orders) ───
  run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','sent','partial','received','cancelled')),
      order_date TEXT NOT NULL DEFAULT (date('now')),
      expected_date TEXT,
      location_id INTEGER,
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── بنود أمر الشراء ───
  run(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty_ordered REAL NOT NULL,
      qty_received REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ─── إيصالات الاستلام (Goods Receipts) ───
  run(`
    CREATE TABLE IF NOT EXISTS purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      receipt_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      po_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty_received REAL NOT NULL,
      unit_cost REAL NOT NULL,
      FOREIGN KEY (receipt_id) REFERENCES purchase_receipts(id) ON DELETE CASCADE,
      FOREIGN KEY (po_item_id) REFERENCES purchase_order_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ─── مدفوعات الموردين ───
  run(`
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      po_id INTEGER,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash'
        CHECK(payment_method IN ('cash','bank_transfer','cheque','other')),
      payment_date TEXT NOT NULL DEFAULT (date('now')),
      reference TEXT,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── جدول الأقساط ───
  run(`
    CREATE TABLE IF NOT EXISTS payment_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      po_id INTEGER,
      installment_number INTEGER NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','partial','paid','overdue')),
      payment_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (payment_id) REFERENCES supplier_payments(id)
    );
  `);

  // ─── فهارس ───
  run(`CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_po_status   ON purchase_orders(status);`);
  run(`CREATE INDEX IF NOT EXISTS idx_payments_supplier ON supplier_payments(supplier_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_installments_due  ON payment_installments(due_date);`);
  run(`CREATE INDEX IF NOT EXISTS idx_installments_status ON payment_installments(status);`);

  console.log('✓ تم إنشاء جداول المرحلة الثانية (الموردون والمشتريات)');
}

module.exports.createProcurementSchema = createProcurementSchema;

// ═══════════════════════════════════════════════════════
//  المرحلة الثالثة — المبيعات والعملاء والتقسيط والمردودات
// ═══════════════════════════════════════════════════════

function createSalesSchema() {
  // ─── العملاء ───
  run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_en TEXT,
      type TEXT NOT NULL DEFAULT 'retail'
        CHECK(type IN ('retail','wholesale','vip','contractor')),
      phone TEXT,
      phone2 TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      country TEXT DEFAULT 'مصر',
      tax_number TEXT,
      contact_person TEXT,
      discount_pct REAL NOT NULL DEFAULT 0,
      credit_limit REAL DEFAULT 0,
      payment_terms INTEGER DEFAULT 0,
      opening_balance REAL DEFAULT 0,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── الفواتير ───
  run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      location_id INTEGER,
      invoice_date TEXT NOT NULL DEFAULT (date('now')),
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','confirmed','partial','paid','cancelled','refunded')),
      payment_type TEXT NOT NULL DEFAULT 'cash'
        CHECK(payment_type IN ('cash','credit','installment')),
      subtotal REAL NOT NULL DEFAULT 0,
      discount_pct REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_pct REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      notes_en TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── بنود الفاتورة ───
  run(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      returned_qty REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ─── مدفوعات العملاء ───
  run(`
    CREATE TABLE IF NOT EXISTS customer_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      invoice_id INTEGER,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash'
        CHECK(payment_method IN ('cash','bank_transfer','cheque','card','other')),
      payment_date TEXT NOT NULL DEFAULT (date('now')),
      reference TEXT,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── أقساط العملاء ───
  run(`
    CREATE TABLE IF NOT EXISTS customer_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      installment_number INTEGER NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','partial','paid','overdue')),
      payment_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (payment_id) REFERENCES customer_payments(id)
    );
  `);

  // ─── مردودات المبيعات ───
  run(`
    CREATE TABLE IF NOT EXISTS sales_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT NOT NULL UNIQUE,
      invoice_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      return_date TEXT NOT NULL DEFAULT (date('now')),
      return_type TEXT NOT NULL DEFAULT 'refund'
        CHECK(return_type IN ('refund','exchange','repair')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','completed','rejected')),
      total_refund REAL NOT NULL DEFAULT 0,
      reason TEXT,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  run(`
    CREATE TABLE IF NOT EXISTS sales_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL,
      invoice_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      condition TEXT DEFAULT 'good'
        CHECK(condition IN ('good','damaged','repair')),
      restock INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (return_id) REFERENCES sales_returns(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ─── فهارس ───
  run(`CREATE INDEX IF NOT EXISTS idx_invoices_customer  ON invoices(customer_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_invoices_status    ON invoices(status);`);
  run(`CREATE INDEX IF NOT EXISTS idx_invoices_date      ON invoices(invoice_date);`);
  run(`CREATE INDEX IF NOT EXISTS idx_cust_pay_customer  ON customer_payments(customer_id);`);
  run(`CREATE INDEX IF NOT EXISTS idx_cust_inst_due      ON customer_installments(due_date);`);
  run(`CREATE INDEX IF NOT EXISTS idx_cust_inst_status   ON customer_installments(status);`);
  run(`CREATE INDEX IF NOT EXISTS idx_returns_invoice    ON sales_returns(invoice_id);`);

  console.log('✓ تم إنشاء جداول المرحلة الثالثة (المبيعات والعملاء)');
}

module.exports.createSalesSchema = createSalesSchema;
