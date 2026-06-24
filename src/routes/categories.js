// routes/categories.js
const express = require('express');
const router = express.Router();
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');

router.use(authenticate);

// GET /api/categories
router.get('/', (req, res) => {
  const categories = all(`SELECT * FROM categories ORDER BY name ASC`);
  res.json({ categories });
});

// POST /api/categories
router.post('/', authorize('admin', 'manager'), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم التصنيف مطلوب' });

  const existing = get(`SELECT id FROM categories WHERE name = ?`, [name]);
  if (existing) return res.status(409).json({ error: 'هذا التصنيف موجود بالفعل' });

  const newId = insert(`INSERT INTO categories (name, description) VALUES (?, ?)`, [name, description || null]);
  logAction(req.user.id, 'create', 'category', newId, { name });
  res.status(201).json({ message: 'تم إنشاء التصنيف بنجاح', category: { id: newId, name, description } });
});

// PUT /api/categories/:id
router.put('/:id', authorize('admin', 'manager'), (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;
  const existing = get(`SELECT * FROM categories WHERE id = ?`, [id]);
  if (!existing) return res.status(404).json({ error: 'التصنيف غير موجود' });

  run(`UPDATE categories SET name = ?, description = ? WHERE id = ?`, [
    name ?? existing.name,
    description ?? existing.description,
    id,
  ]);
  logAction(req.user.id, 'update', 'category', id, req.body);
  res.json({ message: 'تم تحديث التصنيف بنجاح' });
});

// DELETE /api/categories/:id
router.delete('/:id', authorize('admin', 'manager'), (req, res) => {
  const { id } = req.params;
  const inUse = get(`SELECT id FROM products WHERE category_id = ? LIMIT 1`, [id]);
  if (inUse) {
    return res.status(400).json({ error: 'لا يمكن حذف هذا التصنيف لأنه مستخدم في منتجات حالية' });
  }
  run(`DELETE FROM categories WHERE id = ?`, [id]);
  logAction(req.user.id, 'delete', 'category', id, null);
  res.json({ message: 'تم حذف التصنيف بنجاح' });
});

module.exports = router;
