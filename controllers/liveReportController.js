const { wrapAll } = require('../utils/asyncHandler');
const LiveReportSub = require('../models/LiveReportSub');
const live = require('../services/liveReportService');

const nameOf = (u) => (u && (u.name || u.username)) || '';

// GET /api/live-report/key — المفتاح العام للاشتراك (عام: لا يكشف شيئاً)
const getKey = async (req, res) => {
  res.json({ success: true, enabled: live.enabled(), publicKey: live.publicKey() });
};

// POST /api/live-report/subscribe { subscription: { endpoint, keys: { p256dh, auth } }, ua }
const subscribe = async (req, res) => {
  if (!live.enabled()) return res.status(503).json({ success: false, message: 'التقرير الحي غير مفعّل في الخادم (مفاتيح VAPID غير مضبوطة)' });
  const sub = (req.body && req.body.subscription) || {};
  const endpoint = String(sub.endpoint || '');
  const keys = sub.keys || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ success: false, message: 'اشتراك غير صالح' });
  }
  await LiveReportSub.findOneAndUpdate(
    { endpoint },
    { $set: { user: req.user._id, userName: nameOf(req.user), keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, ua: String((req.body && req.body.ua) || '').slice(0, 200), lastError: '' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const sent = await live.sendToUser(req.user._id).catch(() => 0); // أول تقرير فوراً
  res.json({ success: true, sent });
};

// DELETE /api/live-report/subscribe { endpoint }
const unsubscribe = async (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  if (endpoint) await LiveReportSub.deleteOne({ endpoint, user: req.user._id });
  res.json({ success: true });
};

// POST /api/live-report/send-now — تحديث فوري لأجهزة هذا المستخدم
const sendNow = async (req, res) => {
  const sent = await live.sendToUser(req.user._id);
  res.json({ success: true, sent });
};

module.exports = wrapAll({ getKey, subscribe, unsubscribe, sendNow });
