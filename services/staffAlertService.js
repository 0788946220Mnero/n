/*
  ═══════════════════════════════════════════════════════════════
  إشعارات الطاقم — إشعارات حقيقية على أجهزة الموظفين التي ثبّتت لوحة التحكم على الشاشة.

  • يدوي: مدير النظام يكتب إشعاراً ويرسله للجميع، أو لأدوار، أو لمستخدمين بعينهم.
  • تلقائي: حركات المطعم ومبيعاته (بيع، طلب جديد، إلغاء، فتح/إغلاق جرد، مصروف، فتح الدرج…)
    — المدير يختار لكل نوع: مفعّل؟ لمن (أدوار/مستخدمون)؟ وحد أدنى للمبلغ في المبيعات.
  • صاحب الحركة لا يصله إشعار حركته (الكاشير لا يُنبَّه ببيعه).
  • الحساب المعطّل لا يصله شيء، والجهاز الذي ألغى الاشتراك يُحذف تلقائياً.

  القناة: Web Push بنفس مفاتيح VAPID التي يعمل بها «التقرير الحي» (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
  الأحداث تصل من utils/activity.js (كل ما يُسجَّل في سجل النشاط) + طلبات الموقع + فتح الدرج.
  لا ينتظرها شيء: فشل الإشعار لا يمس البيع ولا الطلب أبداً.
  ═══════════════════════════════════════════════════════════════
*/
const StaffDevice = require('../models/StaffDevice');
const StaffAlert = require('../models/StaffAlert');
const live = require('./liveReportService');

const ROLES = ['admin', 'manager', 'cashier', 'employee', 'center', 'observer'];
const ROLE_LABELS = { admin: 'مدير النظام', manager: 'مدير', cashier: 'كاشير', employee: 'موظف', center: 'موظف سنتر', observer: 'مراقب بيانات' };

/** أنواع الحركات — الافتراضي: لمدير النظام، والطلبات الجديدة للكاشير والمدير أيضاً. */
const CATALOG = [
  { type: 'order.new', label: 'طلب جديد من الموقع', hint: 'توصيل أو استلام — برقمه ومبلغه', roles: ['admin', 'manager', 'cashier'], url: 'dashboard.html#orders' },
  { type: 'pos.sale', label: 'بيع سفري / مباشر', hint: 'المبلغ ومن باع وأول الأصناف', roles: ['admin'], amount: true, url: 'dashboard.html#history' },
  { type: 'center.order', label: 'طلب سنتر (هاتفي)', hint: 'اسم الزبون والمبلغ ومن أرسله', roles: ['admin', 'manager', 'cashier'], amount: true, url: 'dashboard.html#orders' },
  { type: 'order.cancel', label: 'إلغاء طلب أو بيع', hint: 'من ألغى ولماذا', roles: ['admin'], url: 'dashboard.html#history' },
  { type: 'shift.open', label: 'فتح جرد', hint: 'من بدأ دوامه', roles: ['admin'], url: 'dashboard.html#shifts' },
  { type: 'shift.close', label: 'إغلاق جرد', hint: 'مبيعات الجرد وعدد طلباته', roles: ['admin'], url: 'dashboard.html#shifts' },
  { type: 'expense.create', label: 'مصروف جديد', hint: 'المبلغ والبند ومن سجّله', roles: ['admin'], amount: true, url: 'dashboard.html#expenses' },
  { type: 'expense.void', label: 'إلغاء مصروف', hint: 'أي سند ألغي ومن ألغاه', roles: ['admin'], url: 'dashboard.html#expenses' },
  { type: 'drawer.open', label: 'فتح الدرج بلا بيع', hint: 'من فتح درج النقود يدوياً', roles: ['admin'], url: 'dashboard.html#orders' },
  { type: 'login', label: 'تسجيل دخول للوحة', hint: 'من دخل ومن أين — معطّل افتراضياً', roles: ['admin'], off: true, url: 'dashboard.html#activity' },
];
const TYPES = CATALOG.map((c) => c.type);
const byType = Object.fromEntries(CATALOG.map((c) => [c.type, c]));

const m3 = (v) => Number(v || 0).toFixed(3);
// المسافات الزائدة تُطوى، والأسطر تبقى (سطر للمبلغ وسطر للأصناف)
const clip = (s, n) => { const t = String(s || '').replace(/[ \t]+/g, ' ').replace(/ *\n+ */g, '\n').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* ═════════ الإعدادات ═════════ */

function defaults() {
  return Object.fromEntries(CATALOG.map((c) => [c.type, { enabled: !c.off, roles: [...c.roles], users: [], minAmount: 0 }]));
}
/** دمج المحفوظ مع الافتراضي، وتنقية ما لا يُعرف. */
function normalize(saved) {
  const out = defaults();
  Object.entries(saved || {}).forEach(([t, v]) => {
    if (!out[t] || !v || typeof v !== 'object') return;
    out[t] = {
      enabled: v.enabled !== false,
      roles: Array.isArray(v.roles) ? [...new Set(v.roles.filter((r) => ROLES.includes(r)))] : out[t].roles,
      users: Array.isArray(v.users) ? [...new Set(v.users.map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)))].slice(0, 100) : [],
      minAmount: Math.max(0, Math.min(100000, Number(v.minAmount) || 0)),
    };
  });
  return out;
}
let cache = null; let cacheAt = 0;
async function settings() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const d = await StaffAlert.findOne({ key: 'settings' }).lean();
  cache = normalize(d && d.events); cacheAt = Date.now();
  return cache;
}
async function saveSettings(events) {
  const clean = normalize(events);
  await StaffAlert.findOneAndUpdate({ key: 'settings' }, { $set: { events: clean } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  cache = clean; cacheAt = Date.now();
  return clean;
}

/* ═════════ المستلمون والإرسال ═════════ */

/**
 * أجهزة المستلمين: target = { mode: 'all'|'roles'|'users', roles, users }، بلا صاحب الحركة،
 * والحسابات النشطة فقط (معطّل أو محذوف ← لا شيء).
 */
async function devicesFor(target, excludeUser) {
  const User = require('../models/User');
  const mode = target && target.mode;
  const q = { isActive: { $ne: false } };
  if (mode === 'roles') q.role = { $in: (target.roles || []).filter((r) => ROLES.includes(r)) };
  else if (mode === 'users') q._id = { $in: (target.users || []).map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)) };
  else if (mode === 'mixed') q.$or = [{ role: { $in: (target.roles || []).filter((r) => ROLES.includes(r)) } }, { _id: { $in: (target.users || []).map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)) } }];
  else if (mode !== 'all') return { devices: [], users: 0 };
  const users = await User.find(q).select('_id').lean();
  let ids = users.map((u) => String(u._id));
  if (excludeUser) ids = ids.filter((id) => id !== String(excludeUser));
  if (!ids.length) return { devices: [], users: 0 };
  const devices = await StaffDevice.find({ user: { $in: ids } }).lean();
  return { devices, users: new Set(devices.map((d) => String(d.user))).size };
}

/** يرسل لأجهزة محددة. tag: إشعارات النوع نفسه تحلّ محل بعضها على شاشة القفل (بلا تراكم) مع تنبيه. */
async function pushTo(devices, { title, body, url, tag, type }) {
  if (!live.enabled() || !devices.length) return { sent: 0, failed: 0 };
  const payload = JSON.stringify({ kind: 'alert', type: type || 'manual', title: clip(title, 80), body: clip(body, 240), url: url || 'dashboard.html', tag, at: Date.now() });
  let sent = 0; let failed = 0;
  await Promise.all(devices.map(async (d) => {
    try {
      await live.webpush().sendNotification({ endpoint: d.endpoint, keys: d.keys }, payload, { TTL: 24 * 3600, urgency: 'high' });
      sent++;
      await StaffDevice.updateOne({ _id: d._id }, { $set: { lastOkAt: new Date(), lastError: '' } });
    } catch (err) {
      failed++;
      const code = err && err.statusCode;
      if (code === 404 || code === 410) await StaffDevice.deleteOne({ _id: d._id }); // الجهاز ألغى الاشتراك
      else await StaffDevice.updateOne({ _id: d._id }, { $set: { lastError: String((err && err.message) || err).slice(0, 200) } });
    }
  }));
  return { sent, failed };
}

async function record(entry) {
  try {
    await StaffAlert.create({ key: 'log', ...entry });
    // سجل محدود: آخر 300 إرسال
    const extra = await StaffAlert.find({ key: 'log' }).sort({ createdAt: -1 }).skip(300).select('_id').lean();
    if (extra.length) await StaffAlert.deleteMany({ _id: { $in: extra.map((x) => x._id) } });
  } catch (e) { console.error('staffAlert log:', e.message); }
}

/** إشعار يدوي من مدير النظام. */
async function sendManual({ title, body, url, target, by }) {
  const { devices, users } = await devicesFor(target);
  if (!devices.length) return { sent: 0, failed: 0, users: 0, devices: 0 }; // لا يُسجَّل ما لم يُرسل
  const r = await pushTo(devices, { title, body, url, tag: `diyar-msg-${Date.now()}`, type: 'manual' });
  await record({ kind: 'manual', type: 'manual', title: clip(title, 80), body: clip(body, 240), target, byName: (by && (by.name || by.username)) || '', users, ...r });
  return { ...r, users, devices: devices.length };
}

/* ═════════ الحركات ═════════ */

/** نص كل حركة — من سجل النشاط (doc) والطلب نفسه إن وُجد. */
function compose(type, d, order) {
  const who = d.userName || 'مستخدم';
  const amt = d.amount != null ? `${m3(d.amount)} د.أ` : '';
  const det = d.details || {};
  const items = order && Array.isArray(order.items)
    ? order.items.slice(0, 3).map((i) => `${i.quantity || 1}× ${i.nameAr || i.name || ''}`).join('، ') + (order.items.length > 3 ? ` +${order.items.length - 3}` : '')
    : '';
  switch (type) {
    case 'order.new': {
      const delivery = order && order.orderType !== 'pickup';
      return { title: `${delivery ? '🚗 طلب توصيل جديد' : '🏪 طلب استلام جديد'} #${d.orderNumber}`, body: `${amt}${order && order.customerName ? ` — ${order.customerName}` : ''}${items ? `\n${items}` : ''}` };
    }
    case 'pos.sale': return { title: `🧾 بيع ${amt}`, body: `فاتورة #${d.orderNumber} — ${who}${items ? `\n${items}` : ''}` };
    case 'center.order': return { title: `📞 طلب سنتر ${amt}`, body: `#${d.orderNumber}${order && order.customerName ? ` — ${order.customerName}` : ''} · أرسله ${who}${items ? `\n${items}` : ''}` };
    case 'order.cancel': return { title: `⛔ أُلغي الطلب #${d.orderNumber}${amt ? ` (${amt})` : ''}`, body: `ألغاه ${who}${det.reason ? ` — السبب: ${det.reason}` : ''}` };
    case 'shift.open': return { title: `🟢 فتح جرد — ${who}`, body: 'بدأ دوامه الآن' };
    case 'shift.close': return { title: `🔒 إغلاق جرد — ${who}`, body: `المبيعات ${amt || '0.000 د.أ'}${det.ordersCount != null ? ` · ${det.ordersCount} طلب` : ''}` };
    case 'expense.create': return { title: `💸 مصروف ${amt}`, body: `${det.name || 'بلا بند'} — من ${det.source || 'الصندوق'} · سجّله ${who}` };
    case 'expense.void': return { title: `↩️ أُلغي مصروف${det.number ? ` #${det.number}` : ''}${amt ? ` (${amt})` : ''}`, body: `${det.name || ''}${det.name ? ' — ' : ''}ألغاه ${who}` };
    case 'drawer.open': return { title: '💵 فُتح الدرج بلا بيع', body: `فتحه ${who}` };
    case 'login': return { title: `🔑 دخول: ${who}`, body: `${ROLE_LABELS[d.role] || d.role || ''}${d.ip ? ` · ${d.ip}` : ''}` };
    default: return null;
  }
}

/** نوع الحركة من سجل النشاط (أو null إن لم تكن مما يُنبَّه به). */
function typeOf(doc) {
  if (doc.action === 'order.cancel') return 'order.cancel';
  return TYPES.includes(doc.action) ? doc.action : null;
}

/**
 * حدث وقع: يُرسل لمن اختارهم المدير لهذا النوع. لا ينتظره أحد ولا يرمي.
 * @param {string} type نوع من CATALOG
 * @param {object} d { userId, userName, role, amount, orderNumber, details, ip }
 * @param {object} [order]
 */
async function emit(type, d, order) {
  try {
    if (!live.enabled() || !byType[type]) return null;
    const cfg = (await settings())[type];
    if (!cfg || !cfg.enabled) return null;
    if (byType[type].amount && cfg.minAmount > 0 && !(Number(d.amount) >= cfg.minAmount)) return null;
    if (!(await StaffDevice.estimatedDocumentCount())) return null;
    const msg = compose(type, d, order);
    if (!msg) return null;
    const { devices, users } = await devicesFor({ mode: 'mixed', roles: cfg.roles, users: cfg.users }, d.userId);
    if (!devices.length) return null;
    const r = await pushTo(devices, { ...msg, url: byType[type].url, tag: `diyar-ev-${type}`, type });
    await record({ kind: 'event', type, title: msg.title, body: msg.body, byName: d.userName || '', users, ...r });
    return r;
  } catch (e) {
    console.error('staffAlert:', type, e.message);
    return null;
  }
}

/** من utils/activity.js — كل عملية مسجّلة. */
function fromActivity(doc, order) {
  const type = typeOf(doc);
  if (!type) return;
  setImmediate(() => emit(type, { userId: doc.user, userName: doc.userName, role: doc.role, amount: doc.amount, orderNumber: doc.orderNumber, details: doc.details, ip: doc.ip }, order));
}

module.exports = { CATALOG, ROLES, ROLE_LABELS, settings, saveSettings, normalize, sendManual, emit, fromActivity, devicesFor, pushTo, compose,
  _reset: () => { cache = null; cacheAt = 0; } };
