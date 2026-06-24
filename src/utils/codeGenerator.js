// utils/codeGenerator.js
const { get } = require('../db/database');

// توليد SKU تلقائي بصيغة PRD-00001 إذا لم يحدد المستخدم كوداً مخصصاً
function generateSKU() {
  const result = get(`SELECT COUNT(*) as count FROM products`);
  const nextNumber = (result ? result.count : 0) + 1;
  return `PRD-${String(nextNumber).padStart(5, '0')}`;
}

// توليد باركود رقمي فريد (EAN-13 مبسط) بناءً على timestamp + رقم عشوائي
// يضمن عدم التكرار عبر التحقق من القاعدة
function generateBarcode() {
  let barcode;
  let exists = true;
  let attempts = 0;

  while (exists && attempts < 10) {
    const timestampPart = Date.now().toString().slice(-9);
    const randomPart = Math.floor(Math.random() * 900 + 100).toString();
    barcode = (timestampPart + randomPart).slice(0, 12);
    // إضافة رقم تحقق بسيط (checksum) كآخر رقم لجعلها 13 رقم شبيهة بـ EAN-13
    let sum = 0;
    for (let i = 0; i < barcode.length; i++) {
      sum += parseInt(barcode[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    barcode = barcode + checkDigit;

    const existing = get(`SELECT id FROM products WHERE barcode = ?`, [barcode]);
    exists = !!existing;
    attempts++;
  }

  return barcode;
}

module.exports = { generateSKU, generateBarcode };
