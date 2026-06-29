// routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { run, get, all, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');

router.use(authenticate);

// ─── Helper: إرجاع IDs المواقع المحددة للمستخدم ───
function getUserLocationIds(userId) {
  const rows = all(
    `SELECT location_id FROM user_location_permissions WHERE user_id = ?`,
    [userId]
  );
  return rows.map(r => r.location_id);
}

// GET /api/users
router.get('/', authorize('admin'), (req, res) => {
  const users = all(
    `SELECT id, full_name, username, role, is_active, can_view_cost_price, created_at FROM users ORDER BY id ASC`
  );
  // أضف المواقع المحددة لكل مستخدم
  const withPerms = users.map(u => ({
    ...u,
    allowed_location_ids: getUserLocationIds(u.id),
  }));
  res.json({ users: withPerms });
});

// POST /api/users
router.post('/', authorize('admin'), (req, res) => {
  const { full_name, username, password, role, can_view_cost_price, allowed_location_ids } = req.body;

  if (!full_name || !username || !password || !role)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

  if (!['admin','manager','sales','warehouse'].includes(role))
    return res.status(400).json({ error: 'الدور غير صحيح' });

  if (get(`SELECT id FROM users WHERE username = ?`, [username]))
    return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const newId = insert(
    `INSERT INTO users (full_name, username, password_hash, role, can_view_cost_price) VALUES (?, ?, ?, ?, ?)`,
    [full_name, username, passwordHash, role, can_view_cost_price ? 1 : 0]
  );

  // حفظ صلاحيات المواقع إن وُجدت
  if (Array.isArray(allowed_location_ids)) {
    run(`DELETE FROM user_location_permissions WHERE user_id = ?`, [newId]);
    for (const locId of allowed_location_ids) {
      insert(`INSERT OR IGNORE INTO user_location_permissions (user_id, location_id) VALUES (?, ?)`, [newId, locId]);
    }
  }

  logAction(req.user.id, 'create', 'user', newId, { username, role });
  res.status(201).json({
    user: { id: newId, full_name, username, role, can_view_cost_price: !!can_view_cost_price,
            allowed_location_ids: getUserLocationIds(newId) },
  });
});

// PUT /api/users/:id
router.put('/:id', authorize('admin'), (req, res) => {
  const { id } = req.params;
  const { full_name, role, is_active, can_view_cost_price, password, allowed_location_ids } = req.body;

  const user = get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

  if (Number(id) === req.user.id && (is_active === 0 || role !== 'admin'))
    return res.status(400).json({ error: 'لا يمكنك تعديل صلاحياتك الخاصة بهذا الشكل' });

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
    run(`UPDATE users SET password_hash = ? WHERE id = ?`, [bcrypt.hashSync(password, 10), id]);
  }

  // تحديث صلاحيات المواقع
  if (Array.isArray(allowed_location_ids)) {
    run(`DELETE FROM user_location_permissions WHERE user_id = ?`, [id]);
    for (const locId of allowed_location_ids) {
      insert(`INSERT OR IGNORE INTO user_location_permissions (user_id, location_id) VALUES (?, ?)`, [id, locId]);
    }
  }

  logAction(req.user.id, 'update', 'user', id, req.body);
  const updated = get(`SELECT id, full_name, username, role, is_active, can_view_cost_price FROM users WHERE id = ?`, [id]);
  res.json({ user: { ...updated, allowed_location_ids: getUserLocationIds(Number(id)) } });
});

// PUT /api/users/:id/locations - تحديث صلاحيات المواقع بشكل مستقل
router.put('/:id/locations', authorize('admin'), (req, res) => {
  const { id } = req.params;
  const { location_ids } = req.body; // مصفوفة IDs المواقع المسموح بها

  if (!get(`SELECT id FROM users WHERE id = ?`, [id]))
    return res.status(404).json({ error: 'المستخدم غير موجود' });

  run(`DELETE FROM user_location_permissions WHERE user_id = ?`, [id]);
  if (Array.isArray(location_ids)) {
    for (const locId of location_ids) {
      insert(`INSERT OR IGNORE INTO user_location_permissions (user_id, location_id) VALUES (?, ?)`, [id, locId]);
    }
  }

  logAction(req.user.id, 'update_location_perms', 'user', id, { location_ids });
  res.json({ message: 'تم تحديث صلاحيات المواقع بنجاح', allowed_location_ids: getUserLocationIds(Number(id)) });
});

// DELETE /api/users/:id
router.delete('/:id', authorize('admin'), (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.user.id)
    return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الخاص' });
  if (!get(`SELECT id FROM users WHERE id = ?`, [id]))
    return res.status(404).json({ error: 'المستخدم غير موجود' });

  run(`UPDATE users SET is_active = 0 WHERE id = ?`, [id]);
  logAction(req.user.id, 'deactivate', 'user', id, null);
  res.json({ message: 'تم تعطيل المستخدم بنجاح' });
});

module.exports = router;
