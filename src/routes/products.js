// routes/products.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { generateSKU, generateBarcode } = require('../utils/codeGenerator');

router.use(authenticate);

// ===================== رفع الصور =====================
const uploadsDir = path.join(__dirname, '../uploads/products');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB حد أقصى
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم. يُسمح فقط بـ JPG, PNG, WEBP, GIF'));
    }
  },
});

// دالة مساعدة لبناء الـ URL الكامل للصورة
function getImageUrl(req, imagePath) {
  if (!imagePath) return null;
  if (imagePath.startsWith('http')) return imagePath;
  const baseUrl = process.env.BASE_URL ||
    `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}${imagePath}`;
}

// دمج بيانات المخزون مع كل منتج (الكمية الإجمالية عبر كل المواقع)
function attachStockSummary(products, req) {
  return products.map((p) => {
    const stockRows = all(
      `SELECT l.id as location_id, l.name as location_name, l.type, COALESCE(i.quantity, 0) as quantity
       FROM locations l
       LEFT JOIN inventory i ON i.location_id = l.id AND i.product_id = ?
       WHERE l.is_active = 1
       ORDER BY l.id`,
      [p.id]
    );
    const totalQty = stockRows.reduce((sum, r) => sum + r.quantity, 0);
    return {
      ...p,
      image_path: getImageUrl(req, p.image_path),
      is_active: !!p.is_active,
      allow_fractional_qty: !!p.allow_fractional_qty,
      stock_by_location: stockRows,
      total_quantity: totalQty,
      is_low_stock: totalQty <= p.min_stock_threshold,
    };
  });
}

// GET /api/products - قائمة المنتجات مع بحث وفلترة
router.get('/', (req, res) => {
  const { search, category_id, low_stock, is_active } = req.query;
  let sql = `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1`;
  const params = [];

  if (search) {
    sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.name_en LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  if (category_id) {
    sql += ` AND p.category_id = ?`;
    params.push(category_id);
  }
  if (is_active !== undefined) {
    sql += ` AND p.is_active = ?`;
    params.push(is_active === 'true' || is_active === '1' ? 1 : 0);
  }

  sql += ` ORDER BY p.created_at DESC`;

  let products = all(sql, params);
  products = attachStockSummary(products, req);

  // فلترة نواقص المخزون (تتم بعد حساب الكمية الإجمالية)
  if (low_stock === 'true') {
    products = products.filter((p) => p.is_low_stock);
  }

  // إخفاء سعر التكلفة عن المستخدمين غير المصرح لهم
  if (!req.user.can_view_cost_price && req.user.role !== 'admin') {
    products = products.map((p) => {
      const { cost_price, ...rest } = p;
      return rest;
    });
  }

  res.json({ products, count: products.length });
});

// GET /api/products/:id - تفاصيل منتج واحد
router.get('/:id', (req, res) => {
  const product = get(
    `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`,
    [req.params.id]
  );
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });

  const [withStock] = attachStockSummary([product], req);

  if (!req.user.can_view_cost_price && req.user.role !== 'admin') {
    delete withStock.cost_price;
  }

  res.json({ product: withStock });
});

// GET /api/products/barcode/:barcode - البحث عن منتج بالباركود (للاستخدام مع قارئ الباركود)
router.get('/barcode/:barcode', (req, res) => {
  const product = get(
    `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.barcode = ?`,
    [req.params.barcode]
  );
  if (!product) return res.status(404).json({ error: 'لا يوجد منتج بهذا الباركود' });

  const [withStock] = attachStockSummary([product], req);
  if (!req.user.can_view_cost_price && req.user.role !== 'admin') {
    delete withStock.cost_price;
  }
  res.json({ product: withStock });
});

// POST /api/products - إنشاء منتج جديد
router.post('/', authorize('admin', 'manager', 'warehouse'), upload.single('image'), (req, res) => {
  try {
    let {
      sku,
      barcode,
      name,
      name_en,
      category_id,
      unit,
      allow_fractional_qty,
      cost_price,
      sale_price,
      min_stock_threshold,
      description,
      initial_quantities, // JSON string: [{location_id, quantity}]
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'اسم المنتج مطلوب' });
    }

    const validUnits = ['piece', 'meter', 'liter', 'kg', 'set'];
    if (unit && !validUnits.includes(unit)) {
      return res.status(400).json({ error: 'وحدة القياس غير صحيحة' });
    }

    // توليد SKU تلقائياً إذا لم يُحدد
    if (!sku || sku.trim() === '') {
      sku = generateSKU();
    } else {
      const existingSku = get(`SELECT id FROM products WHERE sku = ?`, [sku]);
      if (existingSku) {
        return res.status(409).json({ error: 'هذا الكود (SKU) مستخدم بالفعل لمنتج آخر' });
      }
    }

    // توليد باركود تلقائياً إذا لم يُحدد
    if (!barcode || barcode.trim() === '') {
      barcode = generateBarcode();
    } else {
      const existingBarcode = get(`SELECT id FROM products WHERE barcode = ?`, [barcode]);
      if (existingBarcode) {
        return res.status(409).json({ error: 'هذا الباركود مستخدم بالفعل لمنتج آخر' });
      }
    }

    const imagePath = req.file ? `/uploads/products/${req.file.filename}` : null;

    const newProductId = transaction(() => {
      const productId = insert(
        `INSERT INTO products (sku, barcode, name, name_en, category_id, unit, allow_fractional_qty, cost_price, sale_price, min_stock_threshold, description, image_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sku,
          barcode,
          name,
          name_en || null,
          category_id || null,
          unit || 'piece',
          allow_fractional_qty ? 1 : 0,
          parseFloat(cost_price) || 0,
          parseFloat(sale_price) || 0,
          parseFloat(min_stock_threshold) || 0,
          description || null,
          imagePath,
        ]
      );

      // تهيئة صفوف المخزون لكل المواقع بكمية صفر، ثم تطبيق الكميات المبدئية إن وُجدت
      const locations = all(`SELECT id FROM locations WHERE is_active = 1`);
      let initialQtyMap = {};
      if (initial_quantities) {
        try {
          const parsed = JSON.parse(initial_quantities);
          parsed.forEach((item) => {
            initialQtyMap[item.location_id] = parseFloat(item.quantity) || 0;
          });
        } catch (e) {
          // تجاهل إذا كانت الصيغة غير صحيحة
        }
      }

      for (const loc of locations) {
        const qty = initialQtyMap[loc.id] || 0;
        insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, ?)`, [
          productId,
          loc.id,
          qty,
        ]);
        if (qty > 0) {
          insert(
            `INSERT INTO stock_movements (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, notes, user_id)
             VALUES (?, ?, 'initial', ?, 0, ?, 'product_creation', 'كمية مبدئية عند إنشاء المنتج', ?)`,
            [productId, loc.id, qty, qty, req.user.id]
          );
        }
      }

      return productId;
    });

    logAction(req.user.id, 'create', 'product', newProductId, { sku, name });

    const created = get(`SELECT * FROM products WHERE id = ?`, [newProductId]);
    res.status(201).json({ message: 'تم إنشاء المنتج بنجاح', product: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء المنتج: ' + err.message });
  }
});

// PUT /api/products/:id - تعديل منتج
router.put('/:id', authorize('admin', 'manager', 'warehouse'), upload.single('image'), (req, res) => {
  try {
    const { id } = req.params;
    const existing = get(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'المنتج غير موجود' });

    let {
      sku,
      barcode,
      name,
      name_en,
      category_id,
      unit,
      allow_fractional_qty,
      cost_price,
      sale_price,
      min_stock_threshold,
      description,
      is_active,
    } = req.body;

    if (sku && sku !== existing.sku) {
      const dup = get(`SELECT id FROM products WHERE sku = ? AND id != ?`, [sku, id]);
      if (dup) return res.status(409).json({ error: 'هذا الكود (SKU) مستخدم بالفعل لمنتج آخر' });
    }

    if (barcode && barcode !== existing.barcode) {
      const dup = get(`SELECT id FROM products WHERE barcode = ? AND id != ?`, [barcode, id]);
      if (dup) return res.status(409).json({ error: 'هذا الباركود مستخدم بالفعل لمنتج آخر' });
    }

    let imagePath = existing.image_path;
    if (req.file) {
      imagePath = `/uploads/products/${req.file.filename}`;
      // حذف الصورة القديمة إن وُجدت
      if (existing.image_path) {
        const oldPath = path.join(__dirname, '..', existing.image_path.replace('/uploads', 'uploads'));
        fs.unlink(oldPath, () => {});
      }
    }

    run(
      `UPDATE products SET
        sku = ?, barcode = ?, name = ?, name_en = ?, category_id = ?, unit = ?,
        allow_fractional_qty = ?, cost_price = ?, sale_price = ?, min_stock_threshold = ?,
        description = ?, image_path = ?, is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        sku ?? existing.sku,
        barcode ?? existing.barcode,
        name ?? existing.name,
        name_en ?? existing.name_en,
        category_id !== undefined ? category_id : existing.category_id,
        unit ?? existing.unit,
        allow_fractional_qty !== undefined ? (allow_fractional_qty ? 1 : 0) : existing.allow_fractional_qty,
        cost_price !== undefined ? parseFloat(cost_price) : existing.cost_price,
        sale_price !== undefined ? parseFloat(sale_price) : existing.sale_price,
        min_stock_threshold !== undefined ? parseFloat(min_stock_threshold) : existing.min_stock_threshold,
        description ?? existing.description,
        imagePath,
        is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
        id,
      ]
    );

    logAction(req.user.id, 'update', 'product', id, req.body);
    const updated = get(`SELECT * FROM products WHERE id = ?`, [id]);
    res.json({ message: 'تم تحديث المنتج بنجاح', product: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث المنتج: ' + err.message });
  }
});

// DELETE /api/products/:id/image - حذف صورة منتج فقط (بدون التأثير على باقي بيانات المنتج)
router.delete('/:id/image', authorize('admin', 'manager', 'warehouse'), (req, res) => {
  const { id } = req.params;
  const existing = get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!existing) return res.status(404).json({ error: 'المنتج غير موجود' });

  if (existing.image_path) {
    const oldPath = path.join(__dirname, '..', existing.image_path.replace('/uploads', 'uploads'));
    fs.unlink(oldPath, () => {});
  }

  run(`UPDATE products SET image_path = NULL, updated_at = datetime('now') WHERE id = ?`, [id]);
  logAction(req.user.id, 'update', 'product', id, { image_removed: true });
  res.json({ message: 'تم حذف صورة المنتج بنجاح' });
});

// DELETE /api/products/:id - تعطيل منتج (soft delete للحفاظ على سجل الحركات)
router.delete('/:id', authorize('admin', 'manager'), (req, res) => {
  const { id } = req.params;
  const existing = get(`SELECT id FROM products WHERE id = ?`, [id]);
  if (!existing) return res.status(404).json({ error: 'المنتج غير موجود' });

  run(`UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?`, [id]);
  logAction(req.user.id, 'deactivate', 'product', id, null);
  res.json({ message: 'تم تعطيل المنتج بنجاح' });
});

// GET /api/products/:id/movements - سجل حركة منتج معين
router.get('/:id/movements', (req, res) => {
  const movements = all(
    `SELECT sm.*, l.name as location_name, u.full_name as user_name
     FROM stock_movements sm
     LEFT JOIN locations l ON sm.location_id = l.id
     LEFT JOIN users u ON sm.user_id = u.id
     WHERE sm.product_id = ?
     ORDER BY sm.created_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json({ movements });
});

// GET /api/products/print/barcode?ids=1,2,3 — جلب بيانات منتجات للطباعة
router.get('/print/barcode', (req, res) => {
  const { ids } = req.query;
  let products;

  if (ids) {
    const idList = ids.split(',').map(s => parseInt(s.trim())).filter(Boolean);
    if (!idList.length) return res.json({ products: [] });
    const placeholders = idList.map(() => '?').join(',');
    products = all(
      `SELECT p.id, p.name, p.name_en, p.sku, p.barcode, p.sale_price, p.image_path
       FROM products p
       WHERE p.id IN (${placeholders}) AND p.is_active = 1
       ORDER BY p.name`,
      idList
    );
  } else {
    products = all(
      `SELECT p.id, p.name, p.name_en, p.sku, p.barcode, p.sale_price, p.image_path
       FROM products p
       WHERE p.is_active = 1 AND p.barcode IS NOT NULL AND p.barcode != ''
       ORDER BY p.name`
    );
  }

  products = products.map(p => ({
    ...p,
    image_path: getImageUrl(req, p.image_path),
  }));

  res.json({ products, count: products.length });
});

module.exports = router;