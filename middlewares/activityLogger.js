const jwt = require('jsonwebtoken');
const { logActivity } = require('../utils/activity');

/**
 * يسجّل العملية في «سجل المستخدم» عند نجاحها فقط (رمز < 400) — دون تعديل منطق المتحكّم.
 * لا تُسجَّل كلمات مرور ولا رموز: describe يختار الحقول الضرورية صراحةً.
 *
 *   router.post('/', protect, audit('product.create', (req, body) => ({ details: {...} })), createProduct)
 */
const audit = (action, describe) => (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.locals.auditBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    try {
      const body = res.locals.auditBody || {};
      let user = req.user || null;

      // تسجيل الدخول: المستخدم في الرد
      if (!user && body.user && (body.user.id || body.user._id)) {
        const u = body.user;
        user = { _id: u.id || u._id, name: u.name, username: u.username, role: u.role };
      }
      // تسجيل الخروج: من الرمز المرفق (موقَّع، ولو منتهي الصلاحية)
      if (!user && action === 'logout') {
        const h = req.headers.authorization || '';
        if (h.startsWith('Bearer ')) {
          try {
            const d = jwt.verify(h.slice(7), process.env.JWT_SECRET, { ignoreExpiration: true });
            if (d && d.id) user = { _id: d.id, name: d.name || '', role: d.role || '' };
          } catch (_) { /* رمز غير صالح — لا نسجّل */ }
        }
        if (!user) return;
      }

      const extra = describe ? describe(req, body) || {} : {};
      logActivity({ req, user, action, ...extra });
    } catch (e) {
      console.error('audit failed:', e.message);
    }
  });
  next();
};

module.exports = { audit };
