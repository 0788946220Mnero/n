const { wrapAll } = require('../utils/asyncHandler');
const StaffDevice = require('../models/StaffDevice');
const StaffAlert = require('../models/StaffAlert');
const User = require('../models/User');
const live = require('../services/liveReportService');
const svc = require('../services/staffAlertService');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const platformOf = (ua) => (/iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : /Macintosh|Mac OS/i.test(ua) ? 'mac' : 'other');
const disabledMsg = 'الإشعارات غير مفعّلة في الخادم بعد (مفاتيح VAPID غير مضبوطة على سيرفر ميرو السحابي)';

/* ═════════ الجهاز (كل مستخدم على جهازه) ═════════ */

// GET /api/staff-alerts/key — المفتاح العام للاشتراك (عام)
const getKey = async (req, res) => res.json({ success: true, enabled: live.enabled(), publicKey: live.publicKey() });

// GET /api/staff-alerts/devices/me?endpoint=… — هل هذا الجهاز مفعّل لهذا المستخدم؟
const myDevice = async (req, res) => {
  const endpoint = String(req.query.endpoint || '');
  const d = endpoint ? await StaffDevice.findOne({ endpoint, user: req.user._id }).lean() : null;
  const count = await StaffDevice.countDocuments({ user: req.user._id });
  res.json({ success: true, enabled: live.enabled(), registered: !!d, devices: count, lastOkAt: d ? d.lastOkAt : null, lastError: d ? d.lastError : '' });
};

// POST /api/staff-alerts/devices { subscription, ua, standalone } — تفعيل الإشعارات على هذا الجهاز
const subscribe = async (req, res) => {
  if (!live.enabled()) return res.status(503).json({ success: false, message: disabledMsg });
  const sub = (req.body && req.body.subscription) || {};
  const endpoint = String(sub.endpoint || '');
  const keys = sub.keys || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ success: false, message: 'اشتراك غير صالح' });
  }
  const ua = String((req.body && req.body.ua) || req.headers['user-agent'] || '').slice(0, 200);
  // الجهاز لآخر من فعّله عليه (جهاز مشترك بين الكاشيرات: يصل للمسجّل حالياً)
  await StaffDevice.findOneAndUpdate(
    { endpoint },
    { $set: { user: req.user._id, userName: nameOf(req.user), role: req.user.role, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, ua, platform: platformOf(ua), standalone: !!(req.body && req.body.standalone), lastError: '' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const d = await StaffDevice.findOne({ endpoint }).lean();
  const r = await svc.pushTo([d], { title: '🔔 فُعّلت الإشعارات', body: 'ستصلك على هذا الجهاز إشعارات مدير النظام وحركات المطعم التي اختارها لك.', url: 'dashboard.html', tag: 'diyar-hello', type: 'hello' });
  res.json({ success: true, sent: r.sent });
};

// DELETE /api/staff-alerts/devices { endpoint } — إيقافها على هذا الجهاز
const unsubscribe = async (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  if (endpoint) await StaffDevice.deleteOne({ endpoint, user: req.user._id });
  res.json({ success: true });
};

// POST /api/staff-alerts/test — إشعار تجريبي لأجهزتي
const testMine = async (req, res) => {
  if (!live.enabled()) return res.status(503).json({ success: false, message: disabledMsg });
  const devices = await StaffDevice.find({ user: req.user._id }).lean();
  if (!devices.length) return res.status(400).json({ success: false, message: 'الإشعارات غير مفعّلة على أي جهاز لك — فعّلها من زر الجرس 🔔' });
  const r = await svc.pushTo(devices, { title: '🔔 إشعار تجريبي', body: 'إن وصلك هذا فالإشعارات تعمل على هذا الجهاز.', url: 'dashboard.html', tag: 'diyar-test', type: 'test' });
  res.json({ success: r.sent > 0, ...r, message: r.sent ? `وصل إلى ${r.sent} من أجهزتك` : 'لم يصل — راجع إعدادات الإشعارات في الجهاز' });
};

// POST /api/staff-alerts/events { type: 'drawer.open' } — حركة على جهاز الكاشير لا تمر بالخادم (فتح الدرج محلياً)
const reportEvent = async (req, res) => {
  const type = String((req.body && req.body.type) || '');
  if (type !== 'drawer.open') return res.status(400).json({ success: false, message: 'نوع غير مسموح' });
  if (!['admin', 'manager', 'cashier'].includes(req.user.role)) return res.status(403).json({ success: false, message: 'غير مسموح' });
  require('../utils/activity').logActivity({ req, action: 'drawer.open' }); // يُسجَّل ويُرسل إشعاره من سجل النشاط
  res.json({ success: true });
};

/* ═════════ مدير النظام ═════════ */

// GET /api/staff-alerts — الإعدادات والأجهزة والمستخدمون والسجل
const overview = async (req, res) => {
  const [events, devices, users, log] = await Promise.all([
    svc.settings(),
    StaffDevice.find().sort({ updatedAt: -1 }).lean(),
    User.find({ isActive: { $ne: false }, role: { $ne: 'delivery' } }).select('name username role').sort({ role: 1, name: 1 }).lean(),
    StaffAlert.find({ key: 'log' }).sort({ createdAt: -1 }).limit(60).lean(),
  ]);
  const perUser = new Map();
  devices.forEach((d) => { const k = String(d.user); perUser.set(k, (perUser.get(k) || 0) + 1); });
  res.json({
    success: true,
    enabled: live.enabled(),
    catalog: svc.CATALOG.map(({ type, label, hint, amount }) => ({ type, label, hint, amount: !!amount })),
    roles: svc.ROLES.map((r) => ({ key: r, label: svc.ROLE_LABELS[r] })),
    events,
    users: users.map((u) => ({ _id: u._id, name: u.name || u.username, role: u.role, devices: perUser.get(String(u._id)) || 0 })),
    devices: devices.map((d) => ({ _id: d._id, user: d.user, userName: d.userName, role: d.role, platform: d.platform, standalone: d.standalone, lastOkAt: d.lastOkAt, lastError: d.lastError, since: d.createdAt })),
    log: log.map((l) => ({ kind: l.kind, type: l.type, title: l.title, body: l.body, byName: l.byName, users: l.users, sent: l.sent, failed: l.failed, at: l.createdAt })),
  });
};

// PUT /api/staff-alerts/settings { events }
const updateSettings = async (req, res) => {
  const events = await svc.saveSettings((req.body && req.body.events) || {});
  res.json({ success: true, events });
};

// POST /api/staff-alerts/send { title, body, target: { mode, roles, users }, url }
const send = async (req, res) => {
  if (!live.enabled()) return res.status(503).json({ success: false, message: disabledMsg });
  const b = req.body || {};
  const title = String(b.title || '').trim(); const body = String(b.body || '').trim();
  if (!title) return res.status(400).json({ success: false, message: 'اكتب عنوان الإشعار' });
  if (title.length > 80 || body.length > 240) return res.status(400).json({ success: false, message: 'العنوان حتى 80 حرفاً والنص حتى 240' });
  const t = b.target || {};
  const target = { mode: ['all', 'roles', 'users'].includes(t.mode) ? t.mode : 'all', roles: Array.isArray(t.roles) ? t.roles : [], users: Array.isArray(t.users) ? t.users.map(String) : [] };
  if (target.mode === 'roles' && !target.roles.length) return res.status(400).json({ success: false, message: 'اختر دوراً واحداً على الأقل' });
  if (target.mode === 'users' && !target.users.length) return res.status(400).json({ success: false, message: 'اختر مستخدماً واحداً على الأقل' });
  const SECTIONS = ['orders', 'history', 'dashboard', 'shifts', 'expenses', 'pos', 'products', 'settings'];
  const url = SECTIONS.includes(b.section) ? `dashboard.html#${b.section}` : 'dashboard.html';
  const r = await svc.sendManual({ title, body, url, target, by: req.user });
  if (!r.devices) return res.status(400).json({ success: false, message: 'لا يوجد جهاز مفعّل لدى المستلمين — كل مستخدم يفعّلها من زر الجرس 🔔 على جهازه', ...r });
  res.json({ success: true, ...r });
};

// DELETE /api/staff-alerts/devices/:id — إزالة جهاز (مفقود/قديم)
const removeDevice = async (req, res) => {
  await StaffDevice.deleteOne({ _id: req.params.id });
  res.json({ success: true });
};

module.exports = wrapAll({ getKey, myDevice, subscribe, unsubscribe, testMine, reportEvent, overview, updateSettings, send, removeDevice });
