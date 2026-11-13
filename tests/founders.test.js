/**
 * ديون الشركة والمؤسسون:
 *  • دور «مؤسس» على مستخدم موجود، ودخول الواجهة المستقلة بجلسة منفصلة عن اللوحة.
 *  • القسط الشهري يتراكم بالجملة (متأخرات) ولا يزيد على الأقساط القادمة.
 *  • الدفع إجباري بالتوقيع اليدوي ولقطة الوجه ← قيد المراجعة ← ختم مدير النظام (والختم المعتمد مرفوع).
 *  • دفعة دين الشركة المختومة ← حساب المؤسس البنكي «رسوم تأسيس»؛ الدين الشخصي لا يدخل الحساب.
 *  • التصحيح لمدير النظام وحده وبسبب مكتوب، ويُسجَّل.
 *  • الإشعارات للمؤسسين فقط. المنشورات والقوانين والتعليقات واللايك والدردشة.
 *   node --test tests/founders.test.js
 */
process.env.JWT_SECRET = 'founders-secret-0123456789abcdef';
process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey';
process.env.VAPID_PRIVATE_KEY = 'test-private';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'ActivityLog', 'StaffDevice', 'StaffAlert'].forEach((m) => require(`../models/${m}`));
require('../founders/models');
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

const pushed = [];
const live = require('../services/liveReportService');
live.webpush = () => ({ sendNotification: async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); } });
const L = require('../founders/ledger');
let NOW = '2026-11-10';
L.svc.clock = () => new Date(`${NOW}T10:00:00+03:00`);

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const FACE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
let server; let base; const tok = {}; const ids = {}; const ftok = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};
const settle = () => new Promise((r) => setTimeout(r, 60));

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  require('../founders').mount(app, {});
  app.use((err, req, res, _n) => { res.status(err.statusCode || 500).json({ message: err.message }); });
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, role] of [['admin', 'admin'], ['manager', 'manager'], ['ali', 'cashier'], ['omar', 'observer'], ['sami', 'employee']]) {
    const u = await M('User').create({ name: k, username: k, password: require('bcryptjs').hashSync('secret123', 4), role, isActive: true, permissions: [] });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  }
});
test.after(() => { require('../founders/hub')._reset(); server && server.close(); });

test('الإعداد: دور مؤسس لمستخدمين موجودين — مدير النظام وحده، والمدير بلا صلاحية', async () => {
  let r = await call('POST', '/api/founders/admin/founders', { token: tok.manager, body: { userId: ids.ali } });
  assert.equal(r.status, 403);
  for (const k of ['ali', 'omar']) {
    r = await call('POST', '/api/founders/admin/founders', { token: tok.admin, body: { userId: ids[k], title: 'مؤسس', sharePct: 50 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal(r.body.founders.length, 2);
  assert.equal((await M('User').findById(ids.ali).lean()).role, 'cashier', 'الدور الأصلي باقٍ');
});

test('الدخول: بحساب اللوحة نفسه، وغير المؤسس مرفوض، والجلسة منفصلة', async () => {
  let r = await call('POST', '/api/founders/auth/login', { body: { username: 'sami', password: 'secret123' } });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/founders/auth/login', { body: { username: 'ali', password: 'bad' } });
  assert.equal(r.status, 401);
  for (const k of ['ali', 'omar']) {
    r = await call('POST', '/api/founders/auth/login', { body: { username: k, password: 'secret123' } });
    assert.equal(r.status, 200); ftok[k] = r.body.token;
  }
  // توكن اللوحة لا يفتح الواجهة المستقلة
  r = await call('GET', '/api/founders/me', { token: tok.ali });
  assert.equal(r.status, 401);
  r = await call('GET', '/api/founders/me', { token: ftok.ali });
  assert.equal(r.status, 200);
  assert.match(r.body.notice, /لا تُنسب لأحد/);
  // أجهزة إشعارات المؤسسين
  for (const k of ['ali', 'omar']) await call('POST', '/api/founders/push/subscribe', { token: ftok[k], body: { subscription: { endpoint: `https://push.example/${k}`, keys: { p256dh: 'p', auth: 'a' } } } });
});

let debtId; let personalId;
test('الدين: قسط شهري يتراكم بالجملة ولا يزيد على ما بعده', async () => {
  pushed.length = 0;
  let r = await call('POST', '/api/founders/admin/debts', { token: tok.admin, body: { scope: 'company', title: 'قرض المعدات', creditor: 'البنك', totalAmount: 1000, monthlyInstallment: 100, startMonth: '2026-09' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  debtId = r.body.debt._id;
  const d = r.body.debt;
  assert.equal(d.installments, 10);
  assert.equal(d.elapsedInstallments, 3); // أيلول، تشرين الأول، تشرين الثاني
  assert.equal(d.arrears, 300, 'ثلاثة أقساط متراكمة بالجملة');
  assert.equal(d.schedule[3].amount, 100, 'قسط كانون الأول يبقى 100 لا يزيد');
  assert.equal(d.schedule.filter((x) => x.state === 'overdue').length, 2);
  await settle();
  assert.deepEqual([...new Set(pushed.map((p) => p.endpoint))].sort(), ['https://push.example/ali', 'https://push.example/omar']);

  r = await call('POST', '/api/founders/admin/debts', { token: tok.admin, body: { scope: 'personal', owner: ids.omar, title: 'سلفة عمر', totalAmount: 200, monthlyInstallment: 50, startMonth: '2026-11' } });
  assert.equal(r.status, 201); personalId = r.body.debt._id;
  // عليّ لا يرى دين عمر الشخصي
  r = await call('GET', '/api/founders/overview', { token: ftok.ali });
  assert.equal(r.body.debts.length, 1);
  r = await call('GET', `/api/founders/debts/${personalId}`, { token: ftok.ali });
  assert.equal(r.status, 404);
});

let payId;
test('الدفع: التوقيع ولقطة الوجه إجباريان، ثم قيد المراجعة والإشعار للمؤسسين', async () => {
  let r = await call('POST', `/api/founders/debts/${debtId}/pay`, { token: ftok.ali, body: { amount: 300, face: FACE } });
  assert.equal(r.body.code, 'SIGNATURE_REQUIRED');
  r = await call('POST', `/api/founders/debts/${debtId}/pay`, { token: ftok.ali, body: { amount: 300, signature: SIG } });
  assert.equal(r.body.code, 'FACE_REQUIRED');
  r = await call('POST', `/api/founders/debts/${debtId}/pay`, { token: ftok.ali, body: { amount: 2000, signature: SIG, face: FACE } });
  assert.equal(r.status, 400);
  pushed.length = 0;
  r = await call('POST', `/api/founders/debts/${debtId}/pay`, { token: ftok.ali, body: { amount: 300, signature: SIG, face: FACE } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  payId = r.body.payment._id;
  assert.equal(r.body.payment.status, 'review');
  assert.equal(r.body.debt.pending, 300);
  assert.equal(r.body.debt.arrears, 0, 'قيد المراجعة يُحجز');
  assert.equal(r.body.debt.paid, 0, 'لا يُنسب قبل الختم');
  await settle();
  assert.ok(pushed.some((p) => p.endpoint.endsWith('omar') && p.type === 'payment.new'));
  // لا حساب بنكي قبل الختم
  r = await call('GET', '/api/founders/account', { token: ftok.ali });
  assert.equal(r.body.account.balance, 0);
});

test('الختم: بلا ختم معتمد مرفوض، ثم يُرحَّل لحساب المؤسس كرسوم تأسيس', async () => {
  let r = await call('POST', `/api/founders/admin/payments/${payId}/stamp`, { token: tok.admin });
  assert.equal(r.body.code, 'STAMP_REQUIRED');
  r = await call('PUT', '/api/founders/admin/settings', { token: tok.admin, body: { stampImage: SIG } });
  assert.equal(r.status, 200);
  r = await call('POST', `/api/founders/admin/payments/${payId}/stamp`, { token: tok.manager });
  assert.equal(r.status, 403);
  r = await call('POST', `/api/founders/admin/payments/${payId}/stamp`, { token: tok.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.debt.paid, 300);
  assert.equal(r.body.debt.remaining, 700);
  r = await call('POST', `/api/founders/admin/payments/${payId}/stamp`, { token: tok.admin });
  assert.equal(r.status, 409, 'لا يُختم مرتين');
  r = await call('GET', '/api/founders/account', { token: ftok.ali });
  assert.equal(r.body.account.balance, 300);
  assert.equal(r.body.account.byKind.founding_fee, 300);
  // السند للطباعة يحمل الختم والتوقيع والصورة
  r = await call('GET', `/api/founders/payments/${payId}`, { token: ftok.omar });
  assert.equal(r.status, 200);
  assert.equal(r.body.stampImage, SIG);
  assert.equal(r.body.payment.facePhoto, FACE);
});

test('الدين الشخصي: صاحبه وحده يدفع، والختم لا يدخل الحساب البنكي', async () => {
  let r = await call('POST', `/api/founders/debts/${personalId}/pay`, { token: ftok.ali, body: { amount: 50, signature: SIG, face: FACE } });
  assert.equal(r.status, 403);
  r = await call('POST', `/api/founders/debts/${personalId}/pay`, { token: ftok.omar, body: { amount: 50, signature: SIG, face: FACE } });
  assert.equal(r.status, 201);
  r = await call('POST', `/api/founders/admin/payments/${r.body.payment._id}/stamp`, { token: tok.admin });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/founders/account', { token: ftok.omar });
  assert.equal(r.body.account.balance, 0);
});

test('التصحيح: لمدير النظام بسبب مكتوب، ويتبعه الحساب البنكي', async () => {
  let r = await call('POST', `/api/founders/admin/payments/${payId}/correct`, { token: tok.admin, body: { amount: 250 } });
  assert.equal(r.body.code, 'REASON_REQUIRED');
  r = await call('POST', `/api/founders/admin/payments/${payId}/correct`, { token: tok.admin, body: { amount: 250, reason: 'خطأ إدخال: المبلغ الفعلي 250' } });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/founders/account', { token: ftok.ali });
  assert.equal(r.body.account.balance, 250);
  assert.equal(r.body.account.entries[0].corrections.length, 1);
  r = await call('PUT', `/api/founders/admin/debts/${debtId}`, { token: tok.admin, body: { totalAmount: 100, reason: 'خطأ' } });
  assert.equal(r.status, 400, 'لا تقل القيمة عن المدفوع');
  r = await call('POST', '/api/founders/admin/ledger', { token: tok.admin, body: { founder: ids.ali, kind: 'shares', amount: 5000, sharesCount: 50, note: 'أسهم التأسيس' } });
  assert.equal(r.status, 201);
  r = await call('GET', '/api/founders/account', { token: ftok.ali });
  assert.equal(r.body.account.balance, 5250);
  assert.equal(r.body.account.sharesCount, 50);
});

test('المنشورات والقوانين: لايك وتعليق، والقانون من اللوحة يصل للمؤسس المعني', async () => {
  pushed.length = 0;
  let r = await call('POST', '/api/founders/admin/laws', { token: tok.admin, body: { title: 'دوام المؤسسين', text: 'حضور اجتماع الأحد إلزامي', founders: [ids.omar] } });
  assert.equal(r.status, 201);
  assert.equal(r.body.law.lawNumber, 1);
  await settle();
  assert.deepEqual(pushed.map((p) => p.endpoint), ['https://push.example/omar']);
  r = await call('GET', `/api/founders/founders/${ids.omar}`, { token: ftok.ali });
  assert.equal(r.body.laws.length, 1);
  r = await call('GET', `/api/founders/founders/${ids.ali}`, { token: ftok.ali });
  assert.equal(r.body.laws.length, 0);

  r = await call('POST', '/api/founders/posts', { token: ftok.ali, body: { text: 'وصلت المعدات' } });
  assert.equal(r.status, 201);
  const pid = r.body.post._id;
  r = await call('POST', `/api/founders/posts/${pid}/like`, { token: ftok.omar });
  assert.equal(r.body.liked, true);
  r = await call('POST', `/api/founders/posts/${pid}/comments`, { token: ftok.omar, body: { text: 'ممتاز' } });
  assert.equal(r.status, 201);
  r = await call('GET', '/api/founders/posts', { token: ftok.ali });
  const post = r.body.posts.find((p) => p._id === pid);
  assert.equal(post.commentsCount, 1);
  assert.equal(post.likes.length, 1);
  r = await call('DELETE', `/api/founders/posts/${pid}`, { token: ftok.omar });
  assert.equal(r.status, 403);
});

test('الدردشة: مجموعة وخاص، والغريب لا يدخل محادثة خاصة', async () => {
  let r = await call('POST', '/api/founders/chat/messages', { token: ftok.ali, body: { conv: 'group', text: 'السلام عليكم' } });
  assert.equal(r.status, 201);
  const dm = `dm:${[ids.ali, ids.omar].sort().join(':')}`;
  r = await call('POST', '/api/founders/chat/messages', { token: ftok.ali, body: { conv: dm, text: 'خاص' } });
  assert.equal(r.status, 201);
  r = await call('GET', '/api/founders/chat/convs', { token: ftok.omar });
  assert.equal(r.body.convs.find((c) => c.conv === dm).unread, 1);
  await call('POST', '/api/founders/chat/read', { token: ftok.omar, body: { conv: dm } });
  r = await call('GET', '/api/founders/chat/convs', { token: ftok.omar });
  assert.equal(r.body.convs.find((c) => c.conv === dm).unread, 0);
  r = await call('GET', `/api/founders/chat/messages?conv=dm:${ids.sami}:${ids.omar}`, { token: ftok.ali });
  assert.equal(r.status, 403);
});

test('المكالمة: رنين بإشعار قوي حتى الرد أو انتهاء المهلة', async () => {
  pushed.length = 0;
  const r = await call('POST', '/api/founders/calls', { token: ftok.ali, body: { to: ids.omar } });
  assert.equal(r.status, 201);
  await settle();
  const ring = pushed.find((p) => p.kind === 'call');
  assert.ok(ring && ring.endpoint.endsWith('omar') && ring.urgent);
  require('../founders/hub').endCall(require('../founders/hub').calls.get(r.body.callId), 'cancelled');
});

test('إزالة دور المؤسس: الجلسة تسقط والسجلات المالية تبقى', async () => {
  let r = await call('DELETE', `/api/founders/admin/founders/${ids.omar}`, { token: tok.admin });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/founders/me', { token: ftok.omar });
  assert.equal(r.status, 401);
  assert.equal(await M('DebtPayment').countDocuments({ payer: ids.omar }), 1);
});

test('الدفع الجزئي على قسط بعينه: يُحسب على قسطه ولا يتجاوز المتبقي منه', async () => {
  const r0 = await call('POST', '/api/founders/admin/founders', { token: tok.admin, body: { userId: ids.omar } });
  assert.equal(r0.status, 200);
  const lg = await call('POST', '/api/founders/auth/login', { body: { username: 'omar', password: 'secret123' } });
  const ft = lg.body.token;
  let r = await call('POST', '/api/founders/admin/debts', { token: tok.admin, body: { scope: 'company', title: 'دين الأقساط', totalAmount: 600, monthlyInstallment: 200, startMonth: '2026-11' } });
  const id = r.body.debt._id;
  // جزء من قسط كانون الأول (قادم) — لا يمس قسط هذا الشهر
  r = await call('POST', `/api/founders/debts/${id}/pay`, { token: ft, body: { amount: 80, installmentMonth: '2026-12', signature: SIG, face: FACE } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.payment.partial, true);
  assert.equal(r.body.payment.installmentMonth, '2026-12');
  let dec = r.body.debt.schedule.find((x) => x.month === '2026-12');
  assert.equal(dec.inReview, 80); assert.equal(dec.open, 120); assert.equal(dec.state, 'partial-upcoming');
  assert.equal(r.body.debt.arrears, 200, 'قسط تشرين الثاني ما زال مستحقاً كاملاً');
  // أكثر من المتبقي من القسط مرفوض
  r = await call('POST', `/api/founders/debts/${id}/pay`, { token: ft, body: { amount: 150, installmentMonth: '2026-12', signature: SIG, face: FACE } });
  assert.equal(r.status, 400); assert.equal(r.body.open, 120);
  // جزء ثانٍ يكمّل القسط: كل جزء بتوقيعه وصورته
  r = await call('POST', `/api/founders/debts/${id}/pay`, { token: ft, body: { amount: 120, installmentMonth: '2026-12', signature: SIG, face: FACE } });
  assert.equal(r.status, 201);
  dec = r.body.debt.schedule.find((x) => x.month === '2026-12');
  assert.equal(dec.open, 0); assert.equal(dec.parts, 2); assert.equal(dec.state, 'review');
  r = await call('POST', `/api/founders/debts/${id}/pay`, { token: ft, body: { amount: 1, installmentMonth: '2026-12', signature: SIG, face: FACE } });
  assert.equal(r.status, 400, 'لا دفع فوق قسط مكتمل');
  // قسط غير موجود
  r = await call('POST', `/api/founders/debts/${id}/pay`, { token: ft, body: { amount: 10, installmentMonth: '2030-01', signature: SIG, face: FACE } });
  assert.equal(r.status, 400);
  // الختم: الجزء يُرحَّل لحساب المؤسس بقيمته
  const list = await call('GET', `/api/founders/admin/payments?debt=${id}&status=review`, { token: tok.admin });
  const part = list.body.payments.find((p) => p.amount === 80);
  r = await call('POST', `/api/founders/admin/payments/${part._id}/stamp`, { token: tok.admin });
  assert.equal(r.status, 200);
  dec = r.body.debt.schedule.find((x) => x.month === '2026-12');
  assert.equal(dec.covered, 80); assert.equal(dec.inReview, 120);
  // تصحيح مبلغ الجزء لا يتجاوز قيمة القسط
  r = await call('POST', `/api/founders/admin/payments/${part._id}/correct`, { token: tok.admin, body: { amount: 150, reason: 'خطأ إدخال تجريبي' } });
  assert.equal(r.status, 400);
});
