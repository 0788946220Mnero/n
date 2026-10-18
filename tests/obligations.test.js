/**
 * الالتزامات الثابتة: تقسيط يومي حتى موعد السداد، القسط يزيد إن فات يوم، سند بختم «مدفوع»
 * وتوقيع مدير النظام، وبعد الموعد: إشعار وتصدير المتبقي لذمم الموردين ثم دورة الشهر التالي.
 * الساعة مُتحكَّم بها (svc.clock) — الأيام بتوقيت عمّان.
 *   node --test tests/obligations.test.js
 */
process.env.JWT_SECRET = 'obligations-secret-0123456789abcdef';
process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey';
process.env.VAPID_PRIVATE_KEY = 'test-private';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'ActivityLog', 'StaffDevice', 'StaffAlert', 'Expense', 'ExpenseSequence', 'Receivable', 'CapitalEntry', 'FixedObligation', 'ObligationCycle']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

const pushed = [];
const live = require('../services/liveReportService');
live.webpush = () => ({ sendNotification: async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); } });
const S = require('../services/obligationService');
let NOW = '2026-10-18';
S.svc.clock = () => new Date(`${NOW}T10:00:00+03:00`);
const day = (d) => { NOW = d; S._reset(); };

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let server; let base; const tokens = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};
const settle = () => new Promise((r) => setTimeout(r, 80));

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/obligations', require('../routes/obligationRoutes'));
  app.use('/api/expenses', require('../routes/expenseRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (k, role, name) => {
    const u = await M('User').create({ name, username: k, password: 'secret123', role, isActive: true });
    ids[k] = String(u._id); tokens[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  };
  await mk('admin', 'admin', 'مروان'); await mk('manager', 'manager', 'سلمى'); await mk('cashier', 'cashier', 'سامي');
  await mk('cashier2', 'cashier', 'رامي'); await mk('observer', 'observer', 'مراقب');
  // أجهزة الإشعارات: مدير النظام والكاشير
  await M('StaffDevice').create({ user: ids.admin, userName: 'مروان', role: 'admin', endpoint: 'https://push.example/admin', keys: { p256dh: 'p', auth: 'a' } });
  await M('StaffDevice').create({ user: ids.cashier, userName: 'سامي', role: 'cashier', endpoint: 'https://push.example/cashier', keys: { p256dh: 'p', auth: 'a' } });
});
test.after(() => server.close());

let rent; // إيجار 300 حتى 27/10 — 10 أيام من 18/10
test('الإنشاء لمدير النظام وحده وبتوقيعه، والموعد لا يكون في الماضي', async () => {
  const body = { name: 'إيجار المحل', payee: 'أبو خالد (المؤجّر)', phone: '0790000000', amount: 300, dueDate: '2026-10-27', recurrence: 'monthly' };
  assert.equal((await call('POST', '/api/obligations', { token: tokens.cashier, body })).status, 403, 'الكاشير لا ينشئ');
  assert.equal((await call('POST', '/api/obligations', { token: tokens.manager, body })).status, 403, 'المدير لا ينشئ (افتراضياً)');
  const noSig = await call('POST', '/api/obligations', { token: tokens.admin, body });
  assert.equal(noSig.status, 400); assert.equal(noSig.body.code, 'SIGNATURE_REQUIRED');
  assert.equal((await call('POST', '/api/obligations', { token: tokens.admin, body: { ...body, dueDate: '2026-10-10', signature: SIG } })).status, 400, 'موعد في الماضي');
  assert.equal((await call('POST', '/api/obligations', { token: tokens.admin, body: { ...body, payee: '', signature: SIG } })).status, 400, 'لمن يُدفع مطلوب');
  const r = await call('POST', '/api/obligations', { token: tokens.admin, body: { ...body, signature: SIG } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  rent = r.body.obligation;
  assert.equal(rent.approvedSignature, undefined, 'التوقيع لا يُرسل في القوائم');
  assert.equal(rent.cycle.daysTotal, 10);
  assert.equal(rent.today.need, 30, 'قسط اليوم = 300 ÷ 10');
  assert.equal(rent.dueDay, 27);
  // التوقيع حُفظ لمدير النظام: الالتزام الثاني بلا إرسال توقيع
  const r2 = await call('POST', '/api/obligations', { token: tokens.admin, body: { name: 'اشتراك الإنترنت', payee: 'شركة الاتصالات', amount: 25, dueDate: '2026-10-22', recurrence: 'once' } });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.obligation.today.need, 5, '25 ÷ 5 أيام');
});

test('الكاشير يدفع قسط اليوم: سند صرف بتوقيع مدير النظام يدخل جرده — ولا يُدفع مرتين', async () => {
  const r = await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier, body: {} });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = r.body.expense;
  assert.equal(e.amount, 30);
  assert.equal(e.source, 'drawer'); assert.equal(String(e.createdBy), ids.cashier, 'من صندوق الكاشير');
  assert.equal(e.approvedSignature, SIG, 'توقيع مدير النظام على السند');
  assert.equal(e.approvedByName, 'مروان'); assert.equal(e.approvedByRole, 'admin');
  assert.equal(e.paidTo, 'أبو خالد (المؤجّر)');
  assert.equal(e.obligationDay, '2026-10-18'); assert.equal(e.obligationRemaining, 270); assert.equal(e.obligationDaysLeft, 9);
  assert.ok(e.number > 0, 'رقم السند التسلسلي');
  assert.equal(r.body.obligation.today.need, 0);
  const again = await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier, body: {} });
  assert.equal(again.status, 400); assert.match(again.body.message, /مدفوع/);
  // في مصروفات جرد الكاشير
  const mine = await call('GET', '/api/expenses', { token: tokens.cashier });
  assert.ok(mine.body.expenses.some((x) => x._id === e._id));
  await settle();
  assert.ok(pushed.some((p) => p.endpoint.endsWith('/admin') && p.type === 'obligation.pay' && /إيجار المحل/.test(p.title)), 'إشعار الدفع لمدير النظام');
});

test('يوم فات بلا دفع ← القسط يزيد على باقي الأيام + تنبيه صباح اليوم التالي', async () => {
  day('2026-10-19');
  assert.equal((await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier2, body: {} })).body.expense.amount, 30);
  day('2026-10-20'); // لم يُدفع
  await S.sweep({ force: true });
  day('2026-10-21');
  pushed.length = 0;
  const before = (await call('GET', `/api/obligations/${rent._id}`, { token: tokens.cashier })).body;
  // 240 متبقي على 7 أيام (21..27) = 34.2857 ← 34.286
  assert.equal(before.obligation.today.need, 34.286);
  assert.equal(before.obligation.cycle.missedDays, 1);
  const d20 = before.days.find((d) => d.day === '2026-10-20');
  assert.equal(d20.status, 'missed'); assert.equal(d20.need, 30);
  assert.deepEqual(before.days.filter((d) => d.status === 'paid').map((d) => d.day), ['2026-10-18', '2026-10-19']);
  await S.sweep({ force: true }); await settle();
  const miss = pushed.filter((p) => p.type === 'obligation.missed');
  assert.ok(miss.some((p) => p.endpoint.endsWith('/cashier') && /أمس/.test(p.title) && /34\.286/.test(p.body)), 'التنبيه بالقسط الجديد للكاشير');
  await S.sweep({ force: true }); await settle();
  assert.equal(pushed.filter((p) => p.type === 'obligation.missed' && p.endpoint.endsWith('/cashier')).length, miss.filter((p) => p.endpoint.endsWith('/cashier')).length, 'لا يتكرر لليوم نفسه');
});

test('إلغاء قسط (مدير النظام): يعود المبلغ للمتبقي ويُعاد التوزيع', async () => {
  const r = await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier, body: {} });
  assert.equal(r.body.expense.amount, 34.286);
  const v = await call('PATCH', `/api/expenses/${r.body.expense._id}/void`, { token: tokens.admin });
  assert.equal(v.status, 200);
  const g = (await call('GET', `/api/obligations/${rent._id}`, { token: tokens.admin })).body;
  assert.equal(g.obligation.cycle.paid, 60); assert.equal(g.obligation.cycle.remaining, 240);
  assert.equal(g.obligation.today.need, 34.286);
  const cyc = await M('ObligationCycle').findById(g.obligation.cycle._id).lean();
  assert.equal(cyc.paid, 60, 'المجموع الذرّي نقص أيضاً');
});

test('دفعتان في اللحظة نفسها لا تتجاوزان مبلغ الدورة', async () => {
  const [a, b] = await Promise.all([
    call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier, body: { amount: 200 } }),
    call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier2, body: { amount: 200 } }),
  ]);
  const ok = [a, b].filter((x) => x.status === 201);
  assert.equal(ok.length, 1, `واحدة فقط تمر: ${a.status}/${b.status}`);
  const g = (await call('GET', `/api/obligations/${rent._id}`, { token: tokens.admin })).body;
  assert.equal(g.obligation.cycle.paid, 260); assert.equal(g.obligation.cycle.remaining, 40);
  assert.equal((await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier, body: { amount: 41 } })).status, 400, 'أكثر من المتبقي');
});

test('الصلاحيات: المراقب يرى ولا يدفع، المدير يدفع ولا يعدّل، والأرشفة لمدير النظام', async () => {
  assert.equal((await call('GET', '/api/obligations', { token: tokens.observer })).status, 200);
  assert.equal((await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.observer, body: {} })).status, 403);
  assert.equal((await call('PUT', `/api/obligations/${rent._id}`, { token: tokens.manager, body: { amount: 1 } })).status, 403);
  assert.equal((await call('POST', `/api/obligations/${rent._id}/pay`, { token: tokens.cashier, body: { amount: 5, source: 'capital' } })).status, 403, 'رأس المال لصاحب صلاحيته');
  const list = (await call('GET', '/api/obligations', { token: tokens.cashier })).body;
  assert.equal(list.canManage, false); assert.equal(list.canPay, true);
  assert.equal(list.obligations.length, 2);
});

test('بعد موعد السداد: المتبقي يُصدَّر لذمم الموردين + إشعار، وتبدأ دورة الشهر التالي', async () => {
  day('2026-10-27');
  const last = (await call('GET', `/api/obligations/${rent._id}`, { token: tokens.cashier })).body;
  assert.equal(last.obligation.today.need, 40, 'آخر يوم = كل المتبقي');
  day('2026-10-28'); pushed.length = 0;
  const list = (await call('GET', '/api/obligations', { token: tokens.admin })).body;
  await settle();
  const ob = list.obligations.find((x) => x._id === rent._id);
  assert.equal(ob.cycle.seq, 2, 'دورة الشهر التالي');
  assert.equal(ob.cycle.startDay, '2026-10-28'); assert.equal(ob.cycle.dueDay, '2026-11-27');
  assert.equal(ob.cycle.amount, 300);
  assert.equal(ob.today.need, 9.678, '300 ÷ 31 يوماً (28/10..27/11) للأعلى لأقرب فلس');
  const old = await M('ObligationCycle').findOne({ obligation: rent._id, seq: 1 }).lean();
  assert.equal(old.status, 'closed'); assert.equal(old.outcome, 'exported'); assert.equal(old.exportedAmount, 40);
  const rec = await M('Receivable').findById(old.receivable).lean();
  assert.equal(rec.customerName, 'أبو خالد (المؤجّر)'); assert.equal(rec.amount, 40); assert.equal(rec.status, 'unpaid');
  assert.match(rec.notes, /التزام ثابت/);
  assert.ok(pushed.some((p) => p.type === 'obligation.exported' && p.endpoint.endsWith('/admin') && /لم يُسدَّد/.test(p.title)), 'إشعار «لم يُسدَّد» لمدير النظام');
  // التصدير مرة واحدة فقط
  await S.sweep({ force: true });
  assert.equal((await M('Receivable').find({ obligation: rent._id }).lean()).length, 1);
  // قسط من دورة مغلقة لا يُلغى
  const oldPay = await M('Expense').findOne({ obligationCycle: old._id, voided: { $ne: true } }).lean();
  assert.equal((await call('PATCH', `/api/expenses/${oldPay._id}/void`, { token: tokens.admin })).status, 400);
  // اشتراك الإنترنت (مرة واحدة، موعده 22/10 ولم يُدفع شيء): صُدِّر كاملاً بلا دورة جديدة
  const net = list.obligations.find((x) => x.name === 'اشتراك الإنترنت');
  assert.equal(net.cycle.status, 'closed'); assert.equal(net.cycle.outcome, 'exported'); assert.equal(net.cycle.exportedAmount, 25);
  assert.equal(net.today, null);
});

test('المسدَّد كاملاً قبل الموعد يُغلق «مسدّد» بلا ذمة، والموعد 31 ← آخر الشهر', async () => {
  const r = await call('POST', '/api/obligations', { token: tokens.admin, body: { name: 'قسط الثلاجة', payee: 'معرض التبريد', amount: 62, dueDate: '2026-10-31', recurrence: 'monthly' } });
  assert.equal(r.status, 201);
  const id = r.body.obligation._id;
  assert.equal(r.body.obligation.today.need, 15.5, '62 ÷ 4');
  assert.equal((await call('POST', `/api/obligations/${id}/pay`, { token: tokens.cashier, body: { amount: 62 } })).status, 201);
  const g = (await call('GET', `/api/obligations/${id}`, { token: tokens.cashier })).body;
  assert.equal(g.obligation.cycle.remaining, 0);
  assert.equal(g.obligation.today.need, 0);
  assert.ok(g.days.filter((d) => d.day > '2026-10-28').every((d) => d.status === 'done'));
  day('2026-11-01');
  const after = (await call('GET', `/api/obligations/${id}`, { token: tokens.admin })).body;
  const c1 = after.cycles.find((c) => c.seq === 1);
  assert.equal(c1.outcome, 'settled'); assert.equal(c1.receivable, null);
  assert.equal(after.obligation.cycle.dueDay, '2026-11-30', 'نوفمبر 30 يوماً');
});

test('التعديل يعيد حساب القسط، والإيقاف يمنع الدورة القادمة، والأرشفة لا تحذف', async () => {
  day('2026-11-01');
  const r = await call('POST', '/api/obligations', { token: tokens.admin, body: { name: 'صيانة', payee: 'فني', amount: 100, dueDate: '2026-11-10' } });
  const id = r.body.obligation._id;
  assert.equal(r.body.obligation.today.need, 10);
  const u = await call('PUT', `/api/obligations/${id}`, { token: tokens.admin, body: { amount: 200, dueDate: '2026-11-05' } });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.obligation.today.need, 40, '200 ÷ 5');
  assert.equal((await call('POST', `/api/obligations/${id}/stop`, { token: tokens.admin })).status, 200);
  day('2026-11-06');
  const g = (await call('GET', `/api/obligations/${id}`, { token: tokens.admin })).body;
  assert.equal(g.obligation.cycle.seq, 1, 'موقوف: لا دورة جديدة'); assert.equal(g.obligation.cycle.status, 'closed');
  assert.equal(g.obligation.cycle.exportedAmount, 200);
  const res = await call('POST', `/api/obligations/${id}/resume`, { token: tokens.admin });
  assert.equal(res.body.obligation.cycle.startDay, '2026-11-06'); assert.equal(res.body.obligation.cycle.dueDay, '2026-12-05');
  assert.equal((await call('DELETE', `/api/obligations/${id}`, { token: tokens.cashier })).status, 403);
  assert.equal((await call('DELETE', `/api/obligations/${id}`, { token: tokens.admin })).status, 200);
  assert.ok(await M('FixedObligation').findById(id).lean(), 'باقٍ في القاعدة (أرشيف)');
  const arch = (await call('GET', '/api/obligations?archived=1', { token: tokens.admin })).body;
  assert.ok(arch.obligations.some((x) => x._id === id));
});
