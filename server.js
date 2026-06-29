// server.js - نقطة الدخول الرئيسية للسيرفر
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDatabase } = require('./src/db/database');
const { createSchema, seedInitialData, createProcurementSchema, createSalesSchema } = require('./src/db/schema');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// تقديم الصور المرفوعة كملفات ثابتة
app.use('/uploads', express.static(path.join(__dirname, 'src/uploads')));

// تقديم الـ frontend (React build)
const publicPath = path.join(__dirname, 'public');
if (require('fs').existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// فحص صحة السيرفر
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'نظام نجف وإضاءة ERP يعمل بنجاح', timestamp: new Date().toISOString() });
});

// تسجيل المسارات (routes)
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/products', require('./src/routes/products'));
app.use('/api/categories', require('./src/routes/categories'));
app.use('/api/locations', require('./src/routes/locations'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/transfers', require('./src/routes/transfers'));
app.use('/api/import', require('./src/routes/import'));
app.use('/api/suppliers', require('./src/routes/suppliers'));
app.use('/api/purchase-orders', require('./src/routes/purchaseOrders'));
app.use('/api/purchase-receipts', require('./src/routes/purchaseReceipts'));
app.use('/api/supplier-payments', require('./src/routes/supplierPayments'));
app.use('/api/installments', require('./src/routes/installments'));
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/invoices', require('./src/routes/invoices'));
app.use('/api/invoices', require('./src/routes/invoicePdf'));
app.use('/api/customer-payments', require('./src/routes/customerPayments'));
app.use('/api/customer-installments', require('./src/routes/customerInstallments'));
app.use('/api/sales-returns', require('./src/routes/salesReturns'));

// التعامل مع المسارات غير الموجودة في الـ API
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'هذا المسار غير موجود' });
});

// صفحة طباعة الباركود المستقلة
app.get('/barcode-print', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'barcode-print.html'));
});

// SPA Catch-all: أي مسار غير API يُخدَّم بـ index.html (لدعم React Router)
const publicPath2 = path.join(__dirname, 'public');
if (require('fs').existsSync(publicPath2)) {
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(publicPath2, 'index.html'));
  });
}

// التعامل مع الأخطاء العامة (مثل أخطاء multer)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'حدث خطأ غير متوقع في السيرفر' });
});

async function startServer() {
  try {
    await initDatabase();
    createSchema();
    createProcurementSchema();
    createSalesSchema();
    seedInitialData();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('═══════════════════════════════════════════');
      console.log(`✓ السيرفر يعمل على المنفذ ${PORT}`);
      console.log(`✓ نظام نجف وإضاءة ERP - المراحل الأولى والثانية والثالثة`);
      console.log('═══════════════════════════════════════════');
    });
  } catch (err) {
    console.error('فشل بدء تشغيل السيرفر:', err);
    process.exit(1);
  }
}

startServer();