/**
 * إشعارات الطاقم: مدير النظام يرسل لأجهزة المستخدمين، وحركات المطعم ومبيعاته تصل لمن اختارهم.
 * خدمة الإشعارات (Google/Apple) وهمية هنا — تسجّل ما أُرسل لكل جهاز.
 *   node --test tests/staffAlerts.test.js
 */
process.env.JWT_SECRET = 'staff-alerts-secret-0123456789abcdef';
process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey';
process.env.VAPID_PRIVATE_KEY = 'test-private';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'ActivityLog', 'StaffDevice', 'StaffAlert', 'PrintJob', 'Order', 'Expense'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

// خدمة الإشعارات الوهمية: endpoint ينتهي بـ /gone ← 410 (الجهاز ألغى الاشتراك)
const pushed = [];
const live = require('../services/liveReportService');
live.webpush = () => ({
  sendNotification: async (sub, payload) => {
    if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  },
});
const svc = require('../services/staffAlertService');
const { logActivity } = require('../utils/activity');

let server; let base; const tokens = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};
const sub = (k) => ({ subscription: { endpoint: `https://push.example/${k}`, keys: { p256dh: 'p-' + k, auth: 'a-' + k } }, ua: k === 'admin' ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' : 'Mozilla/5.0 (Windows NT 10.0)', standalone: true });
const to = (k) => pushed.filter((p) => p.endpoint === `https://push.example/${k}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await wait(60); await new Promise((r) => setImmediate(r)); await wait(60); };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/staff-alerts', require('../routes/staffAlertRoutes'));
  app.use('/api/print-jobs', require('../routes/printJobRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (k, role, extra = {}) => {
    const u = await M('User').create({ name: { admin: 'مروان', manager: 'سلمى', cashier: 'سامي', cashier2: 'رامي', observer: 'مراقب', employee: 'موظف', off: 'موقوف' }[k], username: k, password: 'secret123', role, isActive: true, ...extra });
    ids[k] = String(u._id); tokens[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  };
  await mk('admin', 'admin'); await mk('manager', 'manager'); await mk('cashier', 'cashier'); await mk('cashier2', 'cashier');
  await mk('observer', 'observer'); await mk('employee', 'employee'); await mk('off', 'cashier');
});
test.after(() => server.close());

test('كل مستخدم يفعّلها على جهازه — حتى مراقب البيانات — ويصله إشعار الترحيب', async () => {
  for (const k of ['admin', 'manager', 'cashier', 'cashier2', 'observer', 'employee', 'off']) {
    const r = await call('POST', '/api/staff-alerts/devices', { token: tokens[k], body: sub(k) });
    assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(to('admin')[0].title, '🔔 فُعّلت الإشعارات');
  const d = await M('StaffDevice').findOne({ endpoint: 'https://push.example/admin' }).lean();
  assert.equal(d.platform, 'ios'); assert.equal(d.standalone, true); assert.equal(d.userName, 'مروان');
  const me = await call('GET', '/api/staff-alerts/devices/me?endpoint=' + encodeURIComponent('https://push.example/cashier'), { token: tokens.cashier });
  assert.equal(me.body.registered, true);
  assert.equal((await call('POST', '/api/staff-alerts/devices', { body: sub('x') })).status, 401, 'بلا تسجيل دخول');
  assert.equal((await call('POST', '/api/staff-alerts/devices', { token: tokens.cashier, body: { subscription: { endpoint: 'http://insecure' } } })).status, 400);
  // الحساب الموقوف بعد التفعيل لا يصله شيء
  await M('User').updateOne({ _id: ids.off }, { $set: { isActive: false } });
});

test('مدير النظام يرسل للجميع، أو لأدوار، أو لمستخدمين بعينهم — وغيره لا يرسل', async () => {
  pushed.length = 0;
  const all = await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: 'اجتماع 5 مساءً', body: 'الكل يحضر', target: { mode: 'all' }, section: 'shifts' } });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.sent, 6); assert.equal(all.body.users, 6);
  assert.equal(to('off').length, 0, 'الحساب الموقوف لا يصله');
  const p = to('cashier')[0];
  assert.equal(p.kind, 'alert'); assert.equal(p.title, 'اجتماع 5 مساءً'); assert.equal(p.url, 'dashboard.html#shifts');
  assert.match(p.tag, /^diyar-msg-/, 'الإشعارات اليدوية لا يحلّ بعضها محل بعض');

  pushed.length = 0;
  const roles = await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: 'للكاشيرات', target: { mode: 'roles', roles: ['cashier'] } } });
  assert.equal(roles.body.sent, 2); assert.deepEqual(pushed.map((x) => x.endpoint).sort(), ['https://push.example/cashier', 'https://push.example/cashier2']);

  pushed.length = 0;
  const users = await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: 'لسامي', target: { mode: 'users', users: [ids.cashier] } } });
  assert.equal(users.body.sent, 1); assert.equal(to('cashier').length, 1);

  assert.equal((await call('POST', '/api/staff-alerts/send', { token: tokens.manager, body: { title: 'x' } })).status, 403, 'المدير (manager) لا يملكها افتراضياً');
  assert.equal((await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: '' } })).status, 400);
  assert.equal((await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: 'x', target: { mode: 'roles', roles: [] } } })).status, 400);
  const none = await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: 'x', target: { mode: 'roles', roles: ['center'] } } });
  assert.equal(none.status, 400); assert.match(none.body.message, /لا يوجد جهاز مفعّل/);

  const ov = await call('GET', '/api/staff-alerts', { token: tokens.admin });
  assert.equal(ov.status, 200);
  assert.equal(ov.body.log[0].title, 'لسامي'); assert.equal(ov.body.log[0].byName, 'مروان'); assert.equal(ov.body.log[0].sent, 1);
  assert.equal(ov.body.users.find((u) => u._id === ids.cashier).devices, 1);
  assert.ok(ov.body.catalog.some((c) => c.type === 'pos.sale' && c.amount));
});

test('الحركات: البيع يصل لمدير النظام، ولا يصل لمن باع، والحد الأدنى للمبلغ يُحترم', async () => {
  svc._reset(); pushed.length = 0;
  const cashier = await M('User').findById(ids.cashier).lean();
  const order = { _id: '0'.repeat(24), orderNumber: 1801, total: 7.5, items: [{ nameAr: 'وجبة شاورما سوبر', quantity: 2 }, { nameAr: 'بيبسي', quantity: 2 }] };
  logActivity({ user: cashier, action: 'pos.sale', order, after: 'preparing' });
  await settle();
  assert.equal(to('admin').length, 1);
  assert.equal(to('admin')[0].title, '🧾 بيع 7.500 د.أ');
  assert.match(to('admin')[0].body, /فاتورة #1801 — سامي\n2× وجبة شاورما سوبر، 2× بيبسي/);
  assert.equal(to('admin')[0].tag, 'diyar-ev-pos.sale', 'مبيعات متتالية: الأحدث يحلّ محل السابق على شاشة القفل');
  assert.equal(pushed.length, 1, 'الافتراضي: البيع لمدير النظام وحده');

  // المدير يوسّعها: للكاشيرات أيضاً، وفوق 10 د.أ فقط
  const s = await call('PUT', '/api/staff-alerts/settings', { token: tokens.admin, body: { events: { 'pos.sale': { enabled: true, roles: ['admin', 'cashier'], users: [], minAmount: 10 } } } });
  assert.equal(s.status, 200); assert.equal(s.body.events['pos.sale'].minAmount, 10);
  assert.equal(s.body.events['order.new'].enabled, true, 'غير المذكور يبقى على افتراضه');
  pushed.length = 0;
  logActivity({ user: cashier, action: 'pos.sale', order });
  await settle();
  assert.equal(pushed.length, 0, 'أقل من 10 د.أ ← لا إشعار');
  logActivity({ user: cashier, action: 'pos.sale', order: { ...order, orderNumber: 1802, total: 23.25 } });
  await settle();
  assert.deepEqual(pushed.map((x) => x.endpoint).sort(), ['https://push.example/admin', 'https://push.example/cashier2'], 'الكاشير الآخر نعم، ومن باع لا');
});

test('الإلغاء، الجرد، المصروف، الدرج — وكل حركة يمكن إيقافها', async () => {
  pushed.length = 0;
  const cashier = await M('User').findById(ids.cashier).lean();
  logActivity({ user: cashier, action: 'order.cancel', order: { _id: '1'.repeat(24), orderNumber: 1790, total: 4 }, details: { reason: 'الزبون غيّر رأيه' } });
  logActivity({ user: cashier, action: 'shift.close', amount: 312.5, details: { shiftId: 's1', ordersCount: 41 } });
  logActivity({ user: cashier, action: 'expense.create', amount: 6, details: { name: 'غاز', source: 'الصندوق' } });
  await settle();
  const titles = to('admin').map((x) => x.title);
  assert.ok(titles.includes('⛔ أُلغي الطلب #1790 (4.000 د.أ)'), titles.join(' | '));
  assert.ok(titles.includes('🔒 إغلاق جرد — سامي'));
  assert.ok(titles.includes('💸 مصروف 6.000 د.أ'));
  assert.match(to('admin').find((x) => x.title.startsWith('⛔')).body, /السبب: الزبون غيّر رأيه/);
  assert.match(to('admin').find((x) => x.title.startsWith('🔒')).body, /المبيعات 312.500 د.أ · 41 طلب/);
  assert.equal(to('manager').length, 0, 'افتراضياً لمدير النظام وحده');

  // فتح الدرج محلياً (DiyarPOS): الكاشير يبلّغ، والموظف لا يستطيع
  pushed.length = 0;
  assert.equal((await call('POST', '/api/staff-alerts/events', { token: tokens.cashier, body: { type: 'drawer.open' } })).status, 200);
  assert.equal((await call('POST', '/api/staff-alerts/events', { token: tokens.employee, body: { type: 'drawer.open' } })).status, 403);
  assert.equal((await call('POST', '/api/staff-alerts/events', { token: tokens.cashier, body: { type: 'pos.sale' } })).status, 400, 'لا تزوير حركات أخرى');
  await settle();
  assert.equal(to('admin')[0].title, '💵 فُتح الدرج بلا بيع'); assert.match(to('admin')[0].body, /سامي/);
  assert.ok(await M('ActivityLog').findOne({ action: 'drawer.open' }).lean(), 'ويُسجَّل في سجل النشاط');

  // إيقاف الإلغاءات ← لا شيء
  await call('PUT', '/api/staff-alerts/settings', { token: tokens.admin, body: { events: { 'order.cancel': { enabled: false } } } });
  pushed.length = 0;
  logActivity({ user: cashier, action: 'order.cancel', order: { _id: '2'.repeat(24), orderNumber: 1791, total: 3 } });
  await settle();
  assert.equal(pushed.length, 0);
  // الدخول معطّل افتراضياً
  logActivity({ user: cashier, action: 'login' });
  await settle();
  assert.equal(pushed.length, 0);
});

test('جهاز ألغى الاشتراك يُحذف تلقائياً، والمستخدم يجرّب أجهزته ويوقفها', async () => {
  const admin = await M('User').findById(ids.admin).lean();
  await M('StaffDevice').create({ user: admin._id, userName: 'مروان', role: 'admin', endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } });
  const t = await call('POST', '/api/staff-alerts/test', { token: tokens.admin });
  assert.equal(t.body.sent, 1); assert.equal(t.body.failed, 1);
  assert.equal(await M('StaffDevice').countDocuments({ endpoint: 'https://push.example/gone' }), 0);
  assert.equal((await call('DELETE', '/api/staff-alerts/devices', { token: tokens.cashier2, body: { endpoint: 'https://push.example/cashier2' } })).status, 200);
  assert.equal(await M('StaffDevice').countDocuments({ user: ids.cashier2 }), 0);
  const none = await call('POST', '/api/staff-alerts/test', { token: tokens.cashier2 });
  assert.equal(none.status, 400);
});

test('بلا مفاتيح VAPID: رسالة واضحة، ولا شيء يتعطّل', async () => {
  const k = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY;
  try {
    const r = await call('POST', '/api/staff-alerts/send', { token: tokens.admin, body: { title: 'x' } });
    assert.equal(r.status, 503); assert.match(r.body.message, /VAPID/);
    assert.equal(await svc.emit('pos.sale', { amount: 50, orderNumber: 1 }), null);
  } finally { process.env.VAPID_PRIVATE_KEY = k; }
});
