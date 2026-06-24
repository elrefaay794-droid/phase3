// routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { run, get, all, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');

// كل الـ routes هنا تتطلب تسجيل دخول، وإدارة المستخدمين مقصورة على admin فقط
router.use(authenticate);

// GET /api/users - عرض كل المستخدمين
router.get('/', authorize('admin'), (req, res) => {
  const users = all(
    `SELECT id, full_name, username, role, is_active, can_view_cost_price, created_at FROM users ORDER BY id ASC`
  );
  res.json({ users });
});

// POST /api/users - إنشاء مستخدم جديد
router.post('/', authorize('admin'), (req, res) => {
  const { full_name, username, password, role, can_view_cost_price } = req.body;

  if (!full_name || !username || !password || !role) {
    return res.status(400).json({ error: 'جميع الحقول مطلوبة (الاسم، اسم المستخدم، كلمة المرور، الدور)' });
  }

  const validRoles = ['admin', 'manager', 'sales', 'warehouse'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'الدور المحدد غير صحيح' });
  }

  const existing = get(`SELECT id FROM users WHERE username = ?`, [username]);
  if (existing) {
    return res.status(409).json({ error: 'اسم المستخدم هذا مستخدم بالفعل' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const newId = insert(
    `INSERT INTO users (full_name, username, password_hash, role, can_view_cost_price) VALUES (?, ?, ?, ?, ?)`,
    [full_name, username, passwordHash, role, can_view_cost_price ? 1 : 0]
  );

  logAction(req.user.id, 'create', 'user', newId, { username, role });

  res.status(201).json({
    user: { id: newId, full_name, username, role, can_view_cost_price: !!can_view_cost_price },
  });
});

// PUT /api/users/:id - تعديل مستخدم
router.put('/:id', authorize('admin'), (req, res) => {
  const { id } = req.params;
  const { full_name, role, is_active, can_view_cost_price, password } = req.body;

  const user = get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!user) {
    return res.status(404).json({ error: 'المستخدم غير موجود' });
  }

  // منع المستخدم من تعطيل نفسه أو نزع صلاحية admin عن نفسه (حماية من قفل النظام)
  if (Number(id) === req.user.id && (is_active === 0 || role !== 'admin')) {
    return res.status(400).json({ error: 'لا يمكنك تعديل صلاحياتك الخاصة بهذا الشكل' });
  }

  run(
    `UPDATE users SET 
      full_name = COALESCE(?, full_name),
      role = COALESCE(?, role),
      is_active = COALESCE(?, is_active),
      can_view_cost_price = COALESCE(?, can_view_cost_price),
      updated_at = datetime('now')
     WHERE id = ?`,
    [full_name ?? null, role ?? null, is_active ?? null, can_view_cost_price ?? null, id]
  );

  if (password) {
    const passwordHash = bcrypt.hashSync(password, 10);
    run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
  }

  logAction(req.user.id, 'update', 'user', id, req.body);
  const updated = get(
    `SELECT id, full_name, username, role, is_active, can_view_cost_price FROM users WHERE id = ?`,
    [id]
  );
  res.json({ user: updated });
});

// DELETE /api/users/:id - تعطيل مستخدم (لا يتم الحذف الفعلي للحفاظ على سجل التدقيق)
router.delete('/:id', authorize('admin'), (req, res) => {
  const { id } = req.params;

  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الخاص' });
  }

  const user = get(`SELECT id FROM users WHERE id = ?`, [id]);
  if (!user) {
    return res.status(404).json({ error: 'المستخدم غير موجود' });
  }

  run(`UPDATE users SET is_active = 0 WHERE id = ?`, [id]);
  logAction(req.user.id, 'deactivate', 'user', id, null);
  res.json({ message: 'تم تعطيل المستخدم بنجاح' });
});

module.exports = router;
