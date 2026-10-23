/**
 * «تواصل مع فريق العمل»: دردشة الزبون (منصة الزبائن، دخول برقم الهاتف) مع الطاقم.
 *  • الزبون يرسل ويقرأ محادثته وحده، ولا يرى معرّفات حسابات الطاقم.
 *  • الطاقم بصلاحية support:reply فقط (الكاشير والمدير افتراضياً، ومدير النظام دائماً).
 *  • الإشعار الفوري يصل لأصحاب الصلاحية وحدهم، والعدّادات (غير المقروء) للطرفين.
 *   node --test tests/support.test.js
 */
process.env.JWT_SECRET = 'support-secret-0123456789abcdef0123';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'PhoneUser', 'SupportThread', 'SupportMessage', 'Customer', 'PushSubscriber'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { ROLE_PERMISSIONS } = require('../utils/permissions');

// نلتقط ما يُرسل عبر /ws بدل الاتصال الحقيقي
const rt = require('../services/realtimeService');
const sent = [];
rt.sendToUsers = (ids, payload) => { sent.push({ ids: [...ids].map(String), payload }); return new Set(ids); };
const support = require('../controllers/supportController');

let server; let base; const tok = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/support', require('../routes/supportRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = async (k, role, permissions = []) => {
    const u = await M('User').create({ name: k, username: k, password: 'x'.repeat(20), role, isActive: true, permissions });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  };
  await staff('admin', 'admin');
  await staff('cashier', 'cashier');
  await staff('manager', 'manager');
  await staff('employee', 'employee');
  await staff('observer', 'observer');
  await staff('custom', 'cashier', ['orders:manage']); // صلاحيات مخصّصة بلا رسائل الزبائن
  const cust = async (k, phone) => {
    const u = await M('PhoneUser').create({ phone, isPhoneVerified: true });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k], type: 'customer' }, process.env.JWT_SECRET);
  };
  await cust('ali', '+962791112233');
  await cust('huda', '+962795556677');
  await M('Customer').create({ name: 'علي الزبون', phone: '0791112233' });
});
test.after(() => server && server.close());

test('الصلاحية الافتراضية: الكاشير والمدير ومدير النظام، لا الموظف ولا المراقب', () => {
  assert.ok(ROLE_PERMISSIONS.cashier.includes('support:reply'));
  assert.ok(ROLE_PERMISSIONS.manager.includes('support:reply'));
  assert.ok(ROLE_PERMISSIONS.admin.includes('support:reply'));
  assert.ok(!ROLE_PERMISSIONS.employee.includes('support:reply'));
  assert.ok(!ROLE_PERMISSIONS.observer.includes('support:reply'));
});

test('الزبون بلا دخول يُرفض، وتوكن الطاقم لا يصلح لمسار الزبون', async () => {
  assert.equal((await call('GET', '/api/support/me')).status, 401);
  assert.equal((await call('POST', '/api/support/me/messages', { body: { text: 'مرحبا' } })).status, 401);
  assert.equal((await call('GET', '/api/support/me', { token: tok.cashier })).status, 401);
});

test('الزبون يرسل رسالته فتصل لأصحاب الصلاحية وحدهم', async () => {
  const empty = await call('GET', '/api/support/me', { token: tok.ali });
  assert.equal(empty.status, 200); assert.equal(empty.body.thread, null);
  assert.equal((await call('POST', '/api/support/me/messages', { token: tok.ali, body: { text: '   ' } })).status, 400, 'رسالة فارغة');
  assert.equal((await call('POST', '/api/support/me/messages', { token: tok.ali, body: { text: 'x'.repeat(1001) } })).status, 400, 'أطول من 1000');

  sent.length = 0;
  const r = await call('POST', '/api/support/me/messages', { token: tok.ali, body: { text: 'هل يوجد توصيل للزرقاء الجديدة؟', name: 'علي' } });
  assert.equal(r.status, 201); assert.equal(r.body.message.from, 'customer');
  assert.equal(sent.length, 1, 'إشعار فوري واحد');
  const to = new Set(sent[0].ids);
  assert.ok(to.has(ids.admin) && to.has(ids.cashier) && to.has(ids.manager), 'مدير النظام والكاشير والمدير');
  assert.ok(!to.has(ids.employee) && !to.has(ids.observer) && !to.has(ids.custom), 'لا يصل لمن لا يملك الصلاحية');
  assert.equal(sent[0].payload.type, 'support.message');
  assert.equal(sent[0].payload.thread.name, 'علي');
  assert.equal(sent[0].payload.thread.unreadStaff, 1);
});

test('الطاقم بلا صلاحية يُرفض (403)، وأصحابها يرون المحادثة', async () => {
  for (const k of ['employee', 'observer', 'custom']) {
    assert.equal((await call('GET', '/api/support/threads', { token: tok[k] })).status, 403, k);
  }
  const list = await call('GET', '/api/support/threads', { token: tok.cashier });
  assert.equal(list.status, 200); assert.equal(list.body.threads.length, 1); assert.equal(list.body.unreadThreads, 1);
  assert.equal(list.body.threads[0].phone, '+962791112233');
  assert.equal((await call('GET', '/api/support/unread', { token: tok.manager })).body.unreadThreads, 1);
});

test('فتح المحادثة يعلّمها مقروءة، والرد يصل للزبون بلا معرّف الموظف', async () => {
  const list = await call('GET', '/api/support/threads', { token: tok.cashier });
  const id = list.body.threads[0]._id;
  const open = await call('GET', `/api/support/threads/${id}`, { token: tok.cashier });
  assert.equal(open.status, 200); assert.equal(open.body.messages.length, 1);
  assert.equal(open.body.customer && open.body.customer.name, 'علي الزبون', 'اسمه من سجل الزبائن برقمه المحلي');
  assert.equal((await call('GET', '/api/support/unread', { token: tok.cashier })).body.unreadThreads, 0);

  assert.equal((await call('GET', '/api/support/threads/123', { token: tok.cashier })).status, 400);
  assert.equal((await call('POST', `/api/support/threads/${id}/messages`, { token: tok.employee, body: { text: 'x' } })).status, 403);
  const rep = await call('POST', `/api/support/threads/${id}/messages`, { token: tok.cashier, body: { text: 'نعم، التوصيل متاح 👍' } });
  assert.equal(rep.status, 201);

  assert.equal((await call('GET', '/api/support/me/unread', { token: tok.ali })).body.unread, 1, 'شارة الزبون');
  const mine = await call('GET', '/api/support/me', { token: tok.ali });
  assert.equal(mine.body.messages.length, 2);
  const last = mine.body.messages[1];
  assert.equal(last.from, 'staff'); assert.equal(last.text, 'نعم، التوصيل متاح 👍'); assert.equal(last.staffName, 'cashier');
  assert.equal(last.staffUser, undefined, 'لا يُكشف معرّف حساب الموظف للزبون');
  assert.equal((await call('GET', '/api/support/me/unread', { token: tok.ali })).body.unread, 0, 'قُرئ بعد الفتح');
});

test('كل زبون يرى محادثته وحده', async () => {
  const h = await call('GET', '/api/support/me', { token: tok.huda });
  assert.equal(h.body.thread, null);
  await call('POST', '/api/support/me/messages', { token: tok.huda, body: { text: 'سؤال عن العروض' } });
  const h2 = await call('GET', '/api/support/me', { token: tok.huda });
  assert.equal(h2.body.messages.length, 1); assert.equal(h2.body.messages[0].text, 'سؤال عن العروض');
  const list = await call('GET', '/api/support/threads', { token: tok.admin });
  assert.equal(list.body.threads.length, 2);
  assert.equal(list.body.threads[0].phone, '+962795556677', 'الأحدث أولاً');
  const q = await call('GET', '/api/support/threads?q=' + encodeURIComponent('0795'), { token: tok.admin });
  assert.equal(q.status, 200);
});

test('إغلاق المحادثة وإعادة فتحها برسالة جديدة من الزبون', async () => {
  const list = await call('GET', '/api/support/threads', { token: tok.admin });
  const id = list.body.threads.find((t) => t.phone === '+962795556677')._id;
  assert.equal((await call('PATCH', `/api/support/threads/${id}`, { token: tok.admin, body: { status: 'bad' } })).status, 400);
  const c = await call('PATCH', `/api/support/threads/${id}`, { token: tok.admin, body: { status: 'closed' } });
  assert.equal(c.body.thread.status, 'closed'); assert.equal(c.body.thread.unreadStaff, 0);
  assert.equal((await call('GET', '/api/support/threads?status=open', { token: tok.admin })).body.threads.length, 1);
  await call('POST', '/api/support/me/messages', { token: tok.huda, body: { text: 'شكراً' } });
  const after = await call('GET', `/api/support/threads/${id}`, { token: tok.admin });
  assert.equal(after.body.thread.status, 'open', 'رسالة الزبون تعيد فتحها');
});

test('حدّ الإرسال: 12 رسالة في الدقيقة للزبون', async () => {
  const u = await M('PhoneUser').create({ phone: '+962790000001', isPhoneVerified: true });
  const t = jwt.sign({ id: String(u._id), type: 'customer' }, process.env.JWT_SECRET);
  let last;
  for (let i = 0; i < 13; i++) last = await call('POST', '/api/support/me/messages', { token: t, body: { text: 'م' + i } });
  assert.equal(last.status, 429);
});

test('من مُنح الصلاحية لاحقاً من «المستخدمون» يصله الإشعار', async () => {
  await M('User').updateOne({ _id: ids.custom }, { $set: { permissions: ['orders:manage', 'support:reply'] } });
  support._resetStaffCache();
  sent.length = 0;
  await call('POST', '/api/support/me/messages', { token: tok.ali, body: { text: 'سؤال آخر' } });
  assert.ok(sent[0].ids.includes(ids.custom));
  assert.equal((await call('GET', '/api/support/threads', { token: tok.custom })).status, 200);
});
