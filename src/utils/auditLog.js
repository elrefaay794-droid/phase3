// utils/auditLog.js
const { run } = require('../db/database');

function logAction(userId, action, entityType, entityId, details) {
  try {
    run(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)`,
      [userId, action, entityType, entityId, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('فشل تسجيل سجل التدقيق:', err.message);
  }
}

module.exports = { logAction };
