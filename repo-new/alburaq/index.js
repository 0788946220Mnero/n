/**
 * شركة البراق للتوصيل — وحدة داخل خادم ديار (نفس الخادم، نفس القاعدة، نفس المستخدمين):
 *
 *   require('./alburaq').mount(app, { realtime });   // في server.js قبل notFound
 *
 *   /api/brq/admin       لوحة التوصيل في لوحة ديار (brq:manage / ledger / settings / prints)
 *   /api/brq/callcenter  كول سنتر البراق (brq:center)
 *   /api/brq/restaurant  «طلب سائق البراق» من حالة طلبات المطعم (brq:request)
 *   /api/brq/store       واجهة المتاجر المستقلة (توكن المتجر)
 *   /api/brq/driver      واجهة الديليفري وتطبيق السائق (توكن السائق)
 *   /api/brq/chat        الدردشة: السائقون والإدارة، المتاجر والإدارة، والخاص (brq:chat / brq:monitor)
 *   /api/brq/geo         قراءة الموقع من رابط مشاركة
 *   wss://…/brq/ws       البث اللحظي (عبر realtimeService.onUpgrade في ديار)
 */
const express = require('express');

/** أخطاء الدوال غير المتزامنة تذهب لمعالج الوحدة بدل أن تعلّق الطلب — لراوترات البراق وحدها. */
function guardAsync(router) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      for (const l of layer.route.stack) {
        const fn = l.handle;
        if (fn.length <= 3) {
          l.handle = function guarded(req, res, next) {
            try {
              const r = fn.call(this, req, res, next);
              if (r && typeof r.catch === 'function') r.catch(next);
            } catch (e) { next(e); }
          };
        }
      }
    } else if (layer.handle && layer.handle.stack) {
      guardAsync(layer.handle);
    }
  }
  return router;
}

function buildRouter() {
  const r = express.Router();
  const chat = require('./routes/chat');
  r.use('/admin', guardAsync(require('./routes/admin')));
  r.use('/callcenter', guardAsync(require('./routes/callcenter')));
  r.use('/restaurant', guardAsync(require('./routes/restaurant').router));
  r.use('/store', guardAsync(require('./routes/store')));
  r.use('/driver/chat', guardAsync(chat.router));
  r.use('/driver', guardAsync(require('./routes/driver')));
  r.use('/chat', chat.router);
  r.use('/geo', guardAsync(require('./routes/geoRoutes')));
  r.get('/health', (_req, res) => res.json({ ok: true, service: 'alburaq' }));
  // معلومات عامة لشاشة «الدخول كزائر» (بلا حساب): التسعير وأسماء المناطق فقط
  r.get('/public/info', (req, res, next) => (async () => {
    const { getSettings } = require('./settings');
    const Area = require('./models/Area');
    const s = await getSettings();
    const areas = await Area.find({ active: true }).select('name').sort({ name: 1 }).lean();
    res.json({ success: true, brand: require('./config').brand, meterFlagFils: s.meterFlagFils, perKmFils: s.perKmFils,
      driverPerKmFils: Math.max(0, s.perKmFils - s.companyCutPerKmFils), offerTimeoutSec: s.offerTimeoutSec, areas: areas.map((a) => a.name) });
  })().catch(next));
  r.use((_req, res) => res.status(404).json({ success: false, message: 'المسار غير موجود' }));
  // معالج أخطاء الوحدة: نفس رسائل البراق، ولا تسقط الأخطاء لمعالج المطعم
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ success: false, message: 'طلب غير صالح' });
    if (err.status && err.status < 500) return res.status(err.status).json({ success: false, message: err.message });
    if (err.name === 'CastError' || err.name === 'BSONError') return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'السجل موجود مسبقاً' });
    console.error('البراق — خطأ غير متوقع:', err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  });
  return r;
}

/**
 * يركّب الوحدة في خادم ديار.
 *   realtime: services/realtimeService في ديار (onUpgrade, emitPrintJob, emitOrderUpdated, endOtherSessions)
 *   sweeper : محرك المهلات (موجات العروض) — افتراضياً يعمل
 */
function mount(app, { realtime, sweeper = true } = {}) {
  const brqRealtime = require('./realtime');
  app.use('/api/brq', buildRouter());
  if (realtime) {
    if (realtime.onUpgrade) realtime.onUpgrade(brqRealtime.WS_PATH, brqRealtime.handleUpgrade);
    require('./services/printService').setRealtime(realtime);
    require('./routes/restaurant').init(realtime);
    // جلسة واحدة لكل مستخدم: الدخول من جهاز آخر يغلق بث البراق القديم أيضاً
    if (typeof realtime.endOtherSessions === 'function' && !realtime.__brqPatched) {
      const orig = realtime.endOtherSessions;
      realtime.endOtherSessions = function patched(userId, keepSid) {
        try { brqRealtime.endOtherSessions(userId, keepSid); } catch (_) {}
        return orig.apply(this, arguments);
      };
      realtime.__brqPatched = true;
    }
  } else {
    require('./routes/restaurant').init(null);
  }
  if (sweeper) require('./services/dispatchService').startSweeper();
}

module.exports = { mount, buildRouter, WS_PATH: '/brq/ws' };
