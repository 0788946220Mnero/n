/**
 * المبيعات وإغلاق الجرد لمدير النظام:
 *  • الكاشير والموظف والمدير بلا صلاحية: لا معاينة جرد ولا إغلاق، ولا سجل طلبات ولا «مبيعاتي» ولا إحصائيات،
 *    و«حالة الطلبات» المفتوحة تبقى لهم ليعملوا عليها.
 *  • مدير النظام يُغلق جرده، أو جرد مستخدم معيّن (يؤرشف طلباته وحده)، أو المطعم كاملاً.
 *  • من يُمنح «إغلاق الجرد» من غير الإدارة يُغلق جرده هو فقط؛ والمدير (manager) الممنوح يُغلق الكل.
 *  • ترحيل لمرة واحدة يسحب صلاحيات المبيعات القديمة من الصلاحيات المخصّصة، ويبقى قرار المدير بعده.
 *   node --test tests/salesPermissions.test.js
 */
process.env.JWT_SECRET = 'sales-secret-0123456789abcdef0123';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
// قاعدة الذاكرة لا تمرّ على تشفير save: نخزّن كلمة المرور مشفّرة كما في القاعدة الحقيقية
const PASS = bcrypt.hashSync('secret123', 4);

['User', 'ActivityLog', 'ShiftSession', 'Expense', 'Order', 'Setting', 'Counter', 'Customer', 'Receivable', 'SystemMigration']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { effectivePermissionsFor, ROLE_PERMISSIONS, SALES_KEYS } = require('../utils/permissions');
const migrations = require('../services/permissionMigrations');

let server; let base; const tokens = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};
let seq = 0;
const sale = (who, total, extra = {}) => M('Order').create({
  orderNumber: `T${++seq}`, source: 'pos', orderType: 'pickup', status: 'delivered', total, subtotal: total,
  paymentMethod: 'cash', handledBy: ids[who], handledByName: who, items: [], ...extra,
});

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', require('../routes/orderRoutes'));
  app.use('/api/shifts', require('../routes/shiftRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (k, role, permissions = []) => {
    const u = await M('User').create({ name: k, username: k, password: PASS, role, isActive: true, permissions });
    ids[k] = String(u._id);
    tokens[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  };
  await mk('admin', 'admin');
  await mk('cashier', 'cashier');
  await mk('cashier2', 'cashier');
  await mk('employee', 'employee');
  await mk('manager', 'manager');
  await mk('boss2', 'manager', ['orders:manage', 'orders:closeShift']); // مدير مُنح إغلاق الجرد
  await mk('trusted', 'cashier', ['orders:manage', 'orders:closeShift']); // كاشير مُنح إغلاق جرده
  await mk('observer', 'observer');
});
test.after(() => server.close());

test('الأدوار الافتراضية: المبيعات وإغلاق الجرد لمدير النظام وحده (ومراقب البيانات يرى)', () => {
  for (const role of ['cashier', 'employee', 'manager', 'center']) {
    const leaked = ROLE_PERMISSIONS[role].filter((k) => SALES_KEYS.includes(k));
    assert.deepEqual(leaked, [], `${role}: ${leaked}`);
  }
  assert.ok(ROLE_PERMISSIONS.cashier.includes('orders:manage'), 'الكاشير يبقى يعمل على الطلبات');
  for (const k of SALES_KEYS) assert.ok(effectivePermissionsFor({ role: 'admin' }).includes(k), `admin ${k}`);
  for (const k of ['orders:view', 'stats:view', 'shifts:view']) assert.ok(ROLE_PERMISSIONS.observer.includes(k), `observer ${k}`);
});

test('الكاشير والموظف والمدير بلا صلاحية: لا جرد ولا مبيعات — و«حالة الطلبات» تبقى', async () => {
  await sale('cashier', 5);
  for (const who of ['cashier', 'employee', 'manager']) {
    const t = tokens[who];
    for (const [m, u, body] of [
      ['GET', '/api/orders/shift-summary'],
      ['GET', '/api/orders/shift-summary?scope=all'],
      ['POST', '/api/orders/close-shift', { password: 'secret123' }],
      ['GET', '/api/orders/shift-overview'],
      ['GET', '/api/orders?includeClosed=true'],
      ['GET', '/api/orders?mine=true&source=pos'],
      ['GET', '/api/orders?shiftId=SHIFT-X'],
      ['GET', '/api/orders/stats/dashboard'],
      ['GET', '/api/shifts'],
    ]) {
      const r = await call(m, u, { token: t, body });
      assert.equal(r.status, 403, `${who} ${m} ${u} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    const live = await call('GET', '/api/orders', { token: t });
    assert.equal(live.status, 200, `${who}: حالة الطلبات تبقى`);
  }
  // فتح الجرد يبقى للكاشير (وقت البداية فقط، بلا أرقام)
  const op = await call('POST', '/api/shifts/open', { token: tokens.cashier });
  assert.equal(op.status, 201, JSON.stringify(op.body));
  assert.equal(op.body.shift.summary == null, true, 'لا أرقام في الجرد المفتوح');
  assert.ok(!(await M('Order').findOne({ orderNumber: 'T1' }).lean()).closed, 'لم يُغلق شيء');
});

test('مدير النظام يُغلق جرد كاشير معيّن وحده — وتبقى طلبات غيره مفتوحة', async () => {
  await sale('cashier', 7);
  await sale('cashier2', 11);
  const pv = await call('GET', `/api/orders/shift-summary?scope=user&userId=${ids.cashier}`, { token: tokens.admin });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.summary.scope, 'user');
  assert.equal(pv.body.summary.userName, 'cashier');
  assert.equal(pv.body.summary.successTotal, 12, 'معاينة جرد الكاشير: 5 + 7');
  assert.equal(pv.body.canCloseAll, true);

  const ov = await call('GET', '/api/orders/shift-overview', { token: tokens.admin });
  assert.ok(ov.body.users.some((u) => u.userId === ids.cashier) && ov.body.users.some((u) => u.userId === ids.cashier2), 'قائمة من لهم جرد مفتوح');

  const bad = await call('POST', '/api/orders/close-shift', { token: tokens.admin, body: { password: 'secret123', scope: 'user' } });
  assert.equal(bad.status, 400, 'بلا اختيار مستخدم: رسالة واضحة');
  const wrong = await call('POST', '/api/orders/close-shift', { token: tokens.admin, body: { password: 'nope', scope: 'user', userId: ids.cashier } });
  assert.equal(wrong.status, 401, 'كلمة مرور مدير النظام نفسه');

  const r = await call('POST', '/api/orders/close-shift', { token: tokens.admin, body: { password: 'secret123', scope: 'user', userId: ids.cashier } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.userName, 'cashier');
  assert.equal(r.body.summary.successTotal, 12);
  assert.match(r.body.message, /جرد cashier/);
  const open = await M('Order').find({ closed: { $ne: true } }).lean();
  assert.deepEqual(open.map((o) => o.handledByName), ['cashier2'], 'جرد الكاشير الثاني لم يُمس');
  const s = await M('ShiftSession').findOne({ shiftId: r.body.shiftId }).lean();
  assert.equal(String(s.user), ids.cashier, 'الدورة دورة الكاشير');
  assert.equal(s.status, 'closed');
  assert.equal(String(s.closedBy), ids.admin, 'وأغلقها مدير النظام');
  const log = await M('ActivityLog').findOne({ action: 'shift.close' }).lean();
  assert.equal(log.details.forUser, 'cashier');
});

test('من يُمنح «إغلاق الجرد»: الكاشير يُغلق جرده هو فقط، والمدير الممنوح يُغلق الكل', async () => {
  await sale('trusted', 3);
  // يطلب جرد غيره أو المطعم كاملاً ← يُعامل كجرده هو
  const pv = await call('GET', `/api/orders/shift-summary?scope=user&userId=${ids.cashier2}`, { token: tokens.trusted });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.summary.userName, 'trusted');
  assert.equal(pv.body.canCloseAll, false);
  const r = await call('POST', '/api/orders/close-shift', { token: tokens.trusted, body: { password: 'secret123', scope: 'all' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.scope, 'mine');
  assert.equal(r.body.summary.successTotal, 3);
  assert.equal((await M('Order').countDocuments({ handledByName: 'cashier2', closed: { $ne: true } })), 1, 'جرد غيره باقٍ');
  assert.equal((await call('GET', '/api/orders/shift-overview', { token: tokens.trusted })).status, 403, 'لا يرى جرد غيره');

  const all = await call('POST', '/api/orders/close-shift', { token: tokens.boss2, body: { password: 'secret123', scope: 'all' } });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.summary.scope, 'all');
  assert.equal(await M('Order').countDocuments({ closed: { $ne: true } }), 0, 'المطعم كاملاً');
});

test('مراقب البيانات: يرى أرقام الجرد ولا يُغلق', async () => {
  assert.equal((await call('GET', '/api/orders/shift-overview', { token: tokens.observer })).status, 200);
  assert.equal((await call('GET', '/api/orders?includeClosed=true', { token: tokens.observer })).status, 200);
  assert.equal((await call('GET', '/api/orders/stats/dashboard', { token: tokens.observer })).status !== 403, true);
  assert.equal((await call('POST', '/api/orders/close-shift', { token: tokens.observer, body: { password: 'secret123' } })).status, 403);
});

test('ترحيل لمرة واحدة: تُسحب صلاحيات المبيعات القديمة من المخصّصة، ويبقى قرار المدير بعده', async () => {
  const mk = (username, role, permissions) => M('User').create({ name: username, username: username.toLowerCase(), password: PASS, role, isActive: true, permissions });
  await mk('legacyCashier', 'cashier', ['orders:view', 'orders:manage', 'orders:closeShift', 'chat:use']);
  await mk('legacyManager', 'manager', ['stats:view', 'shifts:view', 'products:edit']);
  await mk('legacyObserver', 'observer', ['stats:view', 'orders:view']);
  await mk('plainCashier', 'cashier', []);
  const raw = async (u) => (await M('User').findOne({ username: u.toLowerCase() }).lean()).permissions;

  // trusted و boss2 مخصّصان أيضاً ← يُسحب منهما «إغلاق الجرد» (سحبٌ لمرة واحدة ثم يمنحه المدير من جديد)
  const n = await migrations.migrateSalesPermissions();
  assert.equal(n, 4, 'legacyCashier + legacyManager + trusted + boss2');
  assert.deepEqual(await raw('legacyCashier'), ['orders:manage', 'chat:use'], 'تبقى صلاحيات العمل');
  assert.deepEqual(await raw('legacyManager'), ['products:edit']);
  assert.deepEqual(await raw('legacyObserver'), ['stats:view', 'orders:view'], 'مراقب البيانات لا يُمس');
  assert.deepEqual(await raw('plainCashier'), [], 'من يرث دوره لا يُمس');
  const logs = await M('ActivityLog').find({ action: 'permissions.sales' }).lean();
  assert.equal(logs.length, 4, 'كل حساب تغيّر مسجّل في سجل النشاط');
  assert.ok(logs.some((l) => l.details.forUser === 'legacyCashier' && l.details.removed.includes('orders:closeShift')));

  // المدير يمنح «عرض المبيعات» من جديد ← الترحيل لا يسحبها ثانية
  await M('User').updateOne({ username: 'legacycashier' }, { $set: { permissions: ['orders:manage', 'orders:view'] } });
  assert.equal(await migrations.migrateSalesPermissions(), 0);
  assert.deepEqual(await raw('legacyCashier'), ['orders:manage', 'orders:view'], 'قرار المدير يبقى');
});
