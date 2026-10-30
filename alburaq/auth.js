const jwt = require('jsonwebtoken');
const cfg = require('./config');
const Driver = require('./models/Driver');
const Store = require('./models/Store');
// نفس مستخدمي ديار وصلاحياتهم (مستخدمو الإدارة)
const User = require('../models/User');
const { effectivePermissionsFor } = require('../utils/permissions');

/*
 * ثلاثة أنواع حسابات في شركة البراق:
 *   • مستخدمو الإدارة = مستخدمو ديار أنفسهم (رمز { id, sid } من /api/auth/login، جلسة واحدة، «تذكرني»).
 *     يدخلون أقسام البراق حسب صلاحيات brq:* — ومنهم دور «موظف شركة البراق» (company).
 *   • السائق: رقم + PIN + رمز تحقق (توكن typ=driver).
 *   • المتجر: رقم + كلمة مرور (توكن typ=store).
 */
const TTL = { driver: '12h', store: '30d' };

/** صلاحيات البراق في كتالوج ديار (utils/permissions.js). */
const PERM = {
  manage: 'brq:manage',     // الخريطة الحية، السائقون، المتاجر، المناطق، الطلبات
  ledger: 'brq:ledger',     // جرد السائقين والمتاجر، التحصيل، الوصولات
  settings: 'brq:settings', // التسعير وإعدادات التوزيع
  prints: 'brq:prints',     // كشوف الأسعار، الوصولات، تصاريح السائقين
  center: 'brq:center',     // كول سنتر البراق
  chat: 'brq:chat',         // الدردشة مع السائقين والمتاجر
  monitor: 'brq:monitor',   // الإشراف على كل المحادثات الخاصة
  request: 'brq:request',   // طلب سائق البراق من «حالة الطلبات» في المطعم
};

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

const signDriverToken = (driver) =>
  jwt.sign({ typ: 'driver', sub: String(driver._id), v: driver.tokenVersion || 0 }, cfg.jwtSecret, { expiresIn: TTL.driver });

const signStoreToken = (store) =>
  jwt.sign({ typ: 'store', sub: String(store._id), v: store.tokenVersion || 0 }, cfg.jwtSecret, { expiresIn: TTL.store });

const SESSION_REPLACED = { message: 'تم تسجيل الدخول بهذا الحساب من جهاز آخر', code: 'SESSION_REPLACED' };

const unauthorized = (res) =>
  res.status(401).json({ success: false, message: 'انتهت الجلسة، سجّل الدخول مجدداً' });

/**
 * توكن ← { role, id, doc, perms? } أو null — للـ HTTP وللـ WebSocket.
 * مستخدم الإدارة: role = 'staff'، و admin = يرى لوحة البراق، و operator = كول سنتر البراق.
 */
async function resolvePrincipal(token) {
  if (!token) return null;
  let decoded;
  try { decoded = jwt.verify(token, cfg.jwtSecret); } catch (_) { return null; }
  if (!decoded.typ && decoded.id) {
    const u = await User.findById(decoded.id).select('+sessionId');
    if (!u || !u.isActive || u.role === 'delivery') return null;
    if (u.sessionId && decoded.sid !== u.sessionId) return { replaced: true };
    if (u._doc) delete u._doc.sessionId; // لا يغادر رقم الجلسة الخادم
    const perms = effectivePermissionsFor(u);
    return {
      role: 'staff', id: String(u._id), sid: decoded.sid || '', doc: u, perms,
      admin: perms.includes(PERM.manage),
      operator: perms.includes(PERM.center),
      readOnly: u.role === 'observer',
    };
  }
  if (decoded.typ === 'driver') {
    const d = await Driver.findById(decoded.sub);
    if (!d || !d.active || (d.tokenVersion || 0) !== decoded.v) return null;
    return { role: 'driver', id: String(d._id), doc: d };
  }
  if (decoded.typ === 'store') {
    const s = await Store.findById(decoded.sub);
    if (!s || !s.active || (s.tokenVersion || 0) !== decoded.v) return null;
    return { role: 'store', id: String(s._id), doc: s };
  }
  return null;
}

/** مستخدم إدارة يملك إحدى الصلاحيات (بلا صلاحيات = أي مستخدم إدارة). مراقب البيانات يقرأ فقط. */
function requireStaff(...anyOf) {
  return async (req, res, next) => {
    const p = await resolvePrincipal(bearerToken(req)).catch(() => null);
    if (p && p.replaced) return res.status(401).json({ success: false, ...SESSION_REPLACED });
    if (!p || p.role !== 'staff') return unauthorized(res);
    if (anyOf.length && !anyOf.some((k) => p.perms.includes(k))) {
      return res.status(403).json({ success: false, message: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
    }
    if (p.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({ success: false, message: 'حساب مراقب البيانات للعرض فقط — لا يمكنه التعديل', code: 'READ_ONLY' });
    }
    req.user = p.doc;
    req.perms = p.perms;
    next();
  };
}

/** داخل راوتر محمي: صلاحية إضافية لمسار بعينه. */
const can = (...anyOf) => (req, res, next) =>
  (anyOf.some((k) => (req.perms || []).includes(k))
    ? next()
    : res.status(403).json({ success: false, message: 'ليس لديك صلاحية للقيام بهذا الإجراء' }));

function requireRole(role) {
  return async (req, res, next) => {
    const p = await resolvePrincipal(bearerToken(req)).catch(() => null);
    if (!p || p.role !== role) return unauthorized(res);
    if (role === 'driver') req.driver = p.doc;
    if (role === 'store') req.store = p.doc;
    next();
  };
}

const requireDriver = requireRole('driver');
const requireStore = requireRole('store');
const requireAdmin = requireStaff(PERM.manage);
const requireOperator = requireStaff(PERM.center);

module.exports = {
  PERM, SESSION_REPLACED,
  signDriverToken, signStoreToken,
  resolvePrincipal, requireStaff, requireAdmin, requireOperator, requireDriver, requireStore,
  can, bearerToken,
};
