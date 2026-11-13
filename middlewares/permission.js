const { effectivePermissionsFor } = require('../utils/permissions');

/**
 * التحقق من الصلاحية في الخادم (لا يكفي إخفاء الزر في الواجهة).
 * يمرّ المستخدم إن امتلك أيّاً من المفاتيح المذكورة — مع protect قبله دائماً.
 *   router.get('/x', protect, requirePermission('stats:view'), handler)
 */
const requirePermission = (...keys) => (req, res, next) => {
  const perms = effectivePermissionsFor(req.user);
  if (keys.some((k) => perms.includes(k))) return next();
  return res.status(403).json({ success: false, message: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
};

const hasPermission = (user, key) => effectivePermissionsFor(user).includes(key);

module.exports = { requirePermission, hasPermission };
