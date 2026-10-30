/**
 * مراقب البيانات (observer): يرى المبيعات والإحصائيات والجرد ورأس المال وفواتير الموردين
 * وسحوبات الموظفين والمصروفات — ولا يعدّل شيئاً، حتى لو مُنح صلاحية تعديل بالخطأ.
 *   node --test tests/observer.test.js
 */
process.env.JWT_SECRET = 'observer-secret-0123456789abcdef';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Receivable', 'ExpenseSequence', 'CapitalEntry', 'ActivityLog', 'ImageCloud', 'ShiftSession', 'Employee', 'Expense', 'Order', 'Setting', 'Counter']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { effectivePermissionsFor, ROLE_PERMISSIONS, VIEW_KEYS, PERSONAL_KEYS } = require('../utils/permissions');

let server; let base; const tokens = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/capital', require('../routes/capitalRoutes'));
  app.use('/api/receivables', require('../routes/receivableRoutes'));
  app.use('/api/employees', require('../routes/employeeRoutes'));
  app.use('/api/expenses', require('../routes/expenseRoutes'));
  app.use('/api/shifts', require('../routes/shiftRoutes'));
  app.use('/api/orders', require('../routes/orderRoutes'));
  app.use('/api/users', require('../routes/userRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (k, role, permissions = []) => {
    const u = await M('User').create({ name: k, username: k, password: 'secret123', role, isActive: true, permissions });
    ids[k] = String(u._id);
    tokens[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  };
  await mk('admin', 'admin');
  await mk('cashier', 'cashier');
  await mk('observer', 'observer');
  // مُنح «رأس المال: إدارة» بالخطأ — يبقى عرضاً فقط
  await mk('observer2', 'observer', ['capital:manage', 'capital:view', 'receivables:manage']);
  await mk('viewer', 'cashier', ['receivables:view']); // كاشير بصلاحية عرض الذمم فقط
  const r = await call('POST', '/api/receivables', { token: tokens.cashier, body: { customerName: 'محل الأمانة', amount: 9 } });
  ids.recv = r.body.receivable._id;
});
test.after(() => server.close());

test('الصلاحيات: دور المراقب «عرض» فقط، وما مُنح بالخطأ من صلاحيات التعديل يسقط', () => {
  // كل صلاحيات الدور للعرض — عدا الشخصية (دردشته ومكالماته) التي لا تعدّل بيانات المطعم
  assert.deepEqual(ROLE_PERMISSIONS.observer.filter((k) => !VIEW_KEYS.includes(k) && !PERSONAL_KEYS.includes(k)), [], 'كل صلاحيات الدور للعرض');
  assert.deepEqual(PERSONAL_KEYS, ['chat:use', 'chat:calls'], 'الشخصية: الدردشة والمكالمات فقط');
  for (const k of ['stats:view', 'orders:view', 'shifts:view', 'capital:view', 'receivables:view', 'employees:view', 'expenses:view']) {
    assert.ok(ROLE_PERMISSIONS.observer.includes(k), k);
  }
  const eff = effectivePermissionsFor({ role: 'observer', permissions: ['capital:manage', 'capital:view', 'receivables:manage'] });
  assert.deepEqual(eff, ['capital:view'], 'صلاحيات التعديل لا تصل للمراقب');
  assert.ok(!ROLE_PERMISSIONS.manager.includes('capital:view'), 'رأس المال يبقى لمدير النظام افتراضياً');
});

test('يرى: رأس المال، فواتير الموردين وتفاصيلها، الموظفين، المصروفات (الكل)، الجرد', async () => {
  const t = tokens.observer;
  const seen = async (u) => { const r = await call('GET', u, { token: t }); if (process.env.SHOW) console.log(u, r.status); assert.ok(![401, 403].includes(r.status), `${u} → ${r.status} ${JSON.stringify(r.body)}`); return r; };
  await seen('/api/capital');
  const list = await seen('/api/receivables?status=');
  assert.equal(list.status, 200); assert.ok(list.body.data.some((x) => x._id === ids.recv));
  const one = await seen(`/api/receivables/${ids.recv}`);
  assert.equal(one.body.receivable.customerName, 'محل الأمانة');
  await seen('/api/employees');
  const ex = await seen('/api/expenses?scope=all');
  if (ex.status === 200) assert.equal(ex.body.scope, 'all', 'يرى مصروفات الجميع لا مصروفاته فقط');
  await seen('/api/expenses/log');
  await seen('/api/shifts');
  await seen('/api/orders/shift-overview');
});

test('لا يعدّل شيئاً: كل طلب كتابة يُرفض «للعرض فقط» — حتى بصلاحية مُنحت بالخطأ', async () => {
  for (const who of ['observer', 'observer2']) {
    const t = tokens[who];
    const writes = [
      ['POST', '/api/capital', { type: 'deposit', amount: 5 }],
      ['POST', '/api/receivables', { customerName: 'x', amount: 1 }],
      ['POST', `/api/receivables/${ids.recv}/pay`, { paymentMethod: 'cash', source: 'drawer' }],
      ['POST', '/api/expenses', { name: 'x', amount: 1 }],
      ['POST', '/api/employees', { name: 'x' }],
      ['POST', '/api/shifts/open', {}],
      ['PUT', '/api/orders/000000000000000000000000/confirm', {}],
      ['PUT', '/api/orders/000000000000000000000000/status', { status: 'ready' }],
      ['POST', '/api/orders/close-shift', {}],
      ['POST', '/api/orders/pos', { items: [] }],
    ];
    for (const [m, u, body] of writes) {
      const r = await call(m, u, { token: t, body });
      assert.equal(r.status, 403, `${who} ${m} ${u} → ${r.status}`);
      assert.equal(r.body.code, 'READ_ONLY', `${m} ${u}`);
      assert.match(r.body.message, /للعرض فقط/);
    }
  }
  const still = await call('GET', `/api/receivables/${ids.recv}`, { token: tokens.admin });
  assert.equal(still.body.receivable.status, 'unpaid', 'لم يتغير شيء');
});

test('لا يرى ما لم يُمنح: المستخدمون وإدارتهم', async () => {
  assert.equal((await call('GET', '/api/users', { token: tokens.observer })).status, 403);
});

test('صلاحية «عرض الذمم» لغير المراقب: يرى ولا ينشئ', async () => {
  assert.equal((await call('GET', '/api/receivables', { token: tokens.viewer })).status, 200);
  assert.equal((await call('POST', '/api/receivables', { token: tokens.viewer, body: { customerName: 'x', amount: 1 } })).status, 403);
});

test('مدير النظام ينشئ مراقب بيانات ويعدّل صلاحياته', async () => {
  const r = await call('POST', '/api/users', { token: tokens.admin, body: { name: 'مراقب', username: 'obs9', password: 'secret123', role: 'observer' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = r.body.data || r.body.user || r.body;
  assert.equal(u.role, 'observer');
  const id = u._id;
  const up = await call('PUT', `/api/users/${id}`, { token: tokens.admin, body: { permissions: ['stats:view', 'capital:view'] } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const cat = await call('GET', '/api/users/permissions', { token: tokens.admin });
  assert.deepEqual(cat.body.rolePermissions.observer, ROLE_PERMISSIONS.observer);
  assert.ok(cat.body.permissions.find((p) => p.key === 'capital:view').view, 'الكتالوج يعلّم صلاحيات العرض');
});
