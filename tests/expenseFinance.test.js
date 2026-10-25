/**
 * المصاريف ومصدر الصرف والجرد:
 *   مصدر التمويل (صندوق/رأس المال) ووسيلة الدفع (نقداً/كليك) حقلان إلزاميان ومنفصلان؛
 *   كل حركة تُسجَّل مرة واحدة (معرّف العملية)؛ السند وحركة رأس المال معاً أو لا شيء؛
 *   الجرد يخصم النقدي من النقد وكليك من كليك؛ تقرير الفترة والمتوقع مقابل الفعلي.
 *   npm test -- tests/expenseFinance.test.js
 */
process.env.JWT_SECRET = 'expense-finance-secret-0123456789abcdef';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Receivable', 'ExpenseSequence', 'CapitalEntry', 'ActivityLog', 'ShiftSession', 'Employee', 'Expense', 'Order', 'Setting', 'Counter', 'ObligationCycle']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

let server; let base; const tokens = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};
const exp = (token, body) => call('POST', '/api/expenses', { token, body: { category: 'purchases', ...body } });
const summaryOf = async (who) => (await call('GET', `/api/orders/shift-summary?scope=user&userId=${ids[who]}`, { token: tokens.admin })).body.summary;
const capital = async () => (await call('GET', '/api/capital', { token: tokens.admin })).body;
const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/capital', require('../routes/capitalRoutes'));
  app.use('/api/expenses', require('../routes/expenseRoutes'));
  app.use('/api/orders', require('../routes/orderRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (k, role, permissions = []) => {
    // القاعدة في الذاكرة لا تشغّل تشفير الحفظ: كلمة المرور مشفّرة مسبقاً (لإغلاق الجرد)
    const u = await M('User').create({ name: k, username: k, password: require('bcryptjs').hashSync('secret123', 4), role, isActive: true, permissions });
    ids[k] = String(u._id);
    tokens[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  };
  await mk('admin', 'admin');
  await mk('cashier', 'cashier');
  // مبيعات الكاشير: نقدي 20، كليك 15 — المتوقع قبل المصروفات: نقد 20، كليك 15
  let n = 9000;
  for (const [pm, total] of [['cash', 12], ['cash', 8], ['cliq', 15]]) {
    await M('Order').create({ orderNumber: String(n++), customerName: 'سفري', items: [{ nameAr: 'شاورما', quantity: 1, price: total }], itemsTotal: total, total, paymentMethod: pm, source: 'pos', status: 'delivered', handledBy: ids.cashier, brand: 'diyar' });
  }
  // رأس المال: 100
  assert.equal((await call('POST', '/api/capital', { token: tokens.admin, body: { type: 'deposit', amount: 100, note: 'افتتاحي' } })).status, 201);
});
test.after(() => server.close());

test('مصدر التمويل ووسيلة الدفع والتصنيف إلزامية ومنفصلة — لا يُفترض أحدها', async () => {
  const noSrc = await exp(tokens.cashier, { name: 'خبز', amount: 2, paymentMethod: 'cash' });
  assert.equal(noSrc.status, 400); assert.equal(noSrc.body.code, 'SOURCE_REQUIRED');
  const noMethod = await exp(tokens.cashier, { name: 'خبز', amount: 2, source: 'drawer' });
  assert.equal(noMethod.status, 400); assert.equal(noMethod.body.code, 'METHOD_REQUIRED');
  const badMethod = await exp(tokens.cashier, { name: 'خبز', amount: 2, source: 'drawer', paymentMethod: 'card' });
  assert.equal(badMethod.body.code, 'METHOD_REQUIRED', 'الفيزا ليست وسيلة صرف');
  const noCat = await call('POST', '/api/expenses', { token: tokens.cashier, body: { name: 'خبز', amount: 2, source: 'drawer', paymentMethod: 'cash' } });
  assert.equal(noCat.body.code, 'CATEGORY_REQUIRED');
  assert.equal(await M('Expense').countDocuments({}), 0, 'لم يُحفظ شيء');
  const meta = await call('GET', '/api/expenses/meta', { token: tokens.cashier });
  assert.ok(meta.body.categories.some((c) => c.key === 'purchases'));
  assert.ok(!meta.body.categories.some((c) => c.key === 'obligation'), 'تصنيف الالتزام من قسمه فقط');
});

test('صندوق + نقداً: يُخصم من النقد المتوقع فقط · صندوق + كليك: من رصيد كليك فقط', async () => {
  const before = await summaryOf('cashier');
  assert.equal(before.cashNet, 20); assert.equal(before.cliqNet, 15);

  const a = await exp(tokens.cashier, { name: 'خضار', amount: 3.5, source: 'drawer', paymentMethod: 'cash', paidTo: 'الحسبة', clientRef: 'r-cash-1' });
  assert.equal(a.status, 201);
  assert.equal(a.body.expense.account, 'drawer_cash');
  const b = await exp(tokens.cashier, { name: 'غاز', amount: 4, source: 'drawer', paymentMethod: 'cliq', reference: 'CLIQ-778', clientRef: 'r-cliq-1' });
  assert.equal(b.body.expense.account, 'drawer_cliq');
  assert.equal(b.body.expense.reference, 'CLIQ-778');

  const s = await summaryOf('cashier');
  assert.equal(s.expensesTotal, 7.5);
  assert.equal(s.expensesCash, 3.5); assert.equal(s.expensesCliq, 4);
  assert.equal(s.cashNet, 16.5, 'النقد: 20 − 3.5 (الكليك لا يُخصم من النقد)');
  assert.equal(s.cliqNet, 11, 'كليك: 15 − 4');
  assert.deepEqual(s.expenseItems.map((e) => e.method), ['cash', 'cliq']);
  assert.equal((await capital()).balance, 100, 'مصروف الصندوق لا يمسّ رأس المال');
});

test('رأس المال + نقداً/كليك: حركة واحدة على رأس المال ولا يدخل أي جرد', async () => {
  const c1 = await exp(tokens.admin, { name: 'ثلاجة', amount: 30, source: 'capital', paymentMethod: 'cash', category: 'maintenance', clientRef: 'r-cap-1' });
  const c2 = await exp(tokens.admin, { name: 'دفعة مورد', amount: 20, source: 'capital', paymentMethod: 'cliq', clientRef: 'r-cap-2' });
  assert.equal(c1.status, 201); assert.equal(c2.status, 201);
  assert.equal(c2.body.expense.account, 'capital_cliq');
  const cap = await capital();
  assert.equal(cap.balance, 50, '100 − 30 − 20: مرة واحدة لكل سند');
  const entries = await M('CapitalEntry').find({ type: 'expense' }).lean();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.paymentMethod).sort(), ['cash', 'cliq']);
  const s = await summaryOf('admin');
  assert.equal(s.expensesTotal, 0, 'رأس المال خارج جرد من صرفه');
  // الكاشير لا يصرف من رأس المال
  assert.equal((await exp(tokens.cashier, { name: 'x', amount: 1, source: 'capital', paymentMethod: 'cash' })).status, 403);
  // ولا يتجاوز الرصيد
  const over = await exp(tokens.admin, { name: 'كبير', amount: 51, source: 'capital', paymentMethod: 'cash' });
  assert.equal(over.status, 400);
});

test('معرّف العملية: النقرة المزدوجة وإعادة المحاولة والطلبان المتزامنان = سند واحد وحركة واحدة', async () => {
  const body = { name: 'تنظيف', amount: 5, source: 'capital', paymentMethod: 'cash', clientRef: 'r-dbl-1' };
  const [x, y] = await Promise.all([exp(tokens.admin, body), exp(tokens.admin, body)]);
  const again = await exp(tokens.admin, body);
  const nums = [x, y, again].map((r) => r.body.expense.number);
  assert.equal(new Set(nums).size, 1, 'نفس السند في الثلاثة');
  assert.ok([x, y, again].filter((r) => r.body.duplicate).length >= 2);
  assert.equal(await M('Expense').countDocuments({ clientRef: 'r-dbl-1' }), 1);
  assert.equal(await M('CapitalEntry').countDocuments({ expenseNumber: nums[0] }), 1, 'حركة رأس مال واحدة');
  assert.equal((await capital()).balance, 45);
  await new Promise((r) => setTimeout(r, 60));
  const logs = (await M('ActivityLog').find({ action: 'expense.create' }).lean()).filter((l) => l.details && l.details.name === 'تنظيف');
  assert.equal(logs.length, 1, 'سجل نشاط واحد (ولا إشعار ثانٍ للطاقم) رغم ثلاث إرسالات');
  // معرّف مستخدم من غيره لا يكشف سنده
  const other = await exp(tokens.cashier, { ...body, source: 'drawer' });
  assert.equal(other.status, 409);
});

test('فشل الخادم أثناء الحفظ: لا يبقى سند بلا حركة رأس مال (ولا العكس)', async () => {
  const CE = M('CapitalEntry');
  const orig = CE.create;
  CE.create = async () => { throw new Error('انقطع الاتصال بالقاعدة'); };
  const before = await M('Expense').countDocuments({});
  const r = await exp(tokens.admin, { name: 'يفشل', amount: 2, source: 'capital', paymentMethod: 'cash', clientRef: 'r-fail-1' });
  CE.create = orig;
  assert.equal(r.status, 500);
  assert.equal(await M('Expense').countDocuments({}), before, 'السند حُذف لأن حركته لم تُكتب');
  assert.equal((await capital()).balance, 45, 'الرصيد كما هو');
  // إعادة المحاولة بنفس المعرّف بعد عودة القاعدة: تُسجَّل مرة واحدة
  const ok = await exp(tokens.admin, { name: 'يفشل', amount: 2, source: 'capital', paymentMethod: 'cash', clientRef: 'r-fail-1' });
  assert.equal(ok.status, 201);
  assert.equal((await capital()).balance, 43);
});

test('الإلغاء: السند وحركته معاً، والفشل في المنتصف لا يترك إلغاءً جزئياً، والإلغاء المزدوج مرفوض', async () => {
  const e = (await M('Expense').findOne({ clientRef: 'r-fail-1' }).lean());
  const CE = M('CapitalEntry');
  const orig = CE.updateMany;
  CE.updateMany = () => { throw new Error('انقطع'); };
  const bad = await call('PATCH', `/api/expenses/${e._id}/void`, { token: tokens.admin });
  CE.updateMany = orig;
  assert.equal(bad.status, 500);
  assert.equal((await M('Expense').findById(e._id).lean()).voided, false, 'السند أُعيد كما كان');
  assert.equal((await capital()).balance, 43);

  const ok = await call('PATCH', `/api/expenses/${e._id}/void`, { token: tokens.admin });
  assert.equal(ok.status, 200);
  assert.equal((await capital()).balance, 45, 'عاد المبلغ لرأس المال');
  assert.equal((await call('PATCH', `/api/expenses/${e._id}/void`, { token: tokens.admin })).status, 400);
  assert.equal((await capital()).balance, 45, 'لا يعود مرتين');
});

test('تقرير الجرد: حسب المصدر والوسيلة والحساب والتصنيف، والمتوقع نقداً وكليك، والفلاتر', async () => {
  const r = await call('GET', `/api/expenses/report?from=${today}&to=${today}`, { token: tokens.admin });
  assert.equal(r.status, 200);
  const by = (arr, k) => (arr.find((x) => x.key === k) || { amount: 0 }).amount;
  // صندوق: 3.5 نقد + 4 كليك · رأس المال: 30 + 20 + 5 (الملغى خارج التقرير)
  assert.equal(by(r.body.bySource, 'drawer'), 7.5);
  assert.equal(by(r.body.bySource, 'capital'), 55);
  assert.equal(by(r.body.byMethod, 'cash'), 38.5);
  assert.equal(by(r.body.byMethod, 'cliq'), 24);
  assert.equal(by(r.body.byAccount, 'capital_cliq'), 20);
  assert.equal(by(r.body.byAccount, 'drawer_cliq'), 4);
  assert.equal(by(r.body.byCategory, 'maintenance'), 30);
  assert.equal(r.body.totals.amount, 62.5);
  assert.equal(r.body.expected.cash, 16.5, 'المتوقع في الصندوق للفترة');
  assert.equal(r.body.expected.cliq, 11, 'المتوقع في كليك للفترة');
  assert.equal(r.body.expected.capitalExpenses, 55);
  const cliqOnly = await call('GET', `/api/expenses/report?from=${today}&method=cliq&source=drawer`, { token: tokens.admin });
  assert.equal(cliqOnly.body.totals.amount, 4);
  assert.equal((await call('GET', `/api/expenses/report?from=${today}`, { token: tokens.cashier })).status, 403, 'التقرير للمدير');
});

test('إغلاق الجرد بالرصيد الفعلي: يُحفظ الفرق وسببه ويظهر في التقرير', async () => {
  const r = await call('POST', '/api/orders/close-shift', { token: tokens.admin, body: { password: 'secret123', scope: 'user', userId: ids.cashier, actualCash: 16, actualCliq: 11, diffReason: 'نصف دينار فكة ناقصة' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.actual.cashDiff, -0.5);
  assert.equal(r.body.summary.actual.cliqDiff, 0);
  const sess = await M('ShiftSession').findOne({ status: 'closed' }).lean();
  assert.equal(sess.actualCash, 16); assert.equal(sess.cliqNet, 11); assert.equal(sess.diffReason, 'نصف دينار فكة ناقصة');
  const rep = await call('GET', `/api/expenses/report?from=${today}`, { token: tokens.admin });
  const sh = rep.body.shifts[0];
  assert.equal(sh.expectedCash, 16.5); assert.equal(sh.actualCash, 16); assert.equal(sh.cashDiff, -0.5);
  // رقم غير صالح يُرفض قبل أي إغلاق
  assert.equal((await call('POST', '/api/orders/close-shift', { token: tokens.admin, body: { password: 'secret123', actualCash: -3 } })).status, 400);
});
