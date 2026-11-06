/**
 * محرك الربحية — المرحلة 3: توزيع البنود، العمالة عبر منتصف الليل، قائمة الدخل اليومية بأرقام محسوبة يدوياً،
 * فصل النقد عن الربح، تقرير الجرد والمطابقة، التفسير، والصلاحيات عبر API.
 */
process.env.JWT_SECRET = 'set-secret-set-secret-set-secret-0001';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['Order', 'Product', 'Category', 'Employee', 'Counter', 'User', 'Expense', 'ShiftSession', 'AttendanceShift', 'ActivityLog', 'FixedObligation', 'StaffAlert', 'StaffDevice', 'Setting'].forEach((m) => require(`../models/${m}`));
['Ingredient', 'Recipe', 'StockMovement', 'SaleCost', 'StockReceipt', 'StockCount', 'InternalUse', 'CostItem', 'ProfitConfig'].forEach((m) => require(`../profit/models/${m}`));
const db = require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const inv = require('../profit/services/inventory');
const cons = require('../profit/services/consumption');
const cfgSvc = require('../profit/services/config');
const { allocateDay } = require('../profit/services/allocation');
const { laborForDays } = require('../profit/services/labor');
const { compute, explainChange } = require('../profit/services/pnl');
const T = require('../profit/services/time');

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const at = (day, hh, mm = 0) => { const [y, m, d] = day.split('-').map(Number); return T.ammanToUtc(y, m, d, hh, mm); };
const DAY = '2026-10-14'; // أربعاء
const CFG = { dayStartHour: 6, workDaysPerMonth: 26, defaultShiftHours: 8, overtimeMultiplier: 1.25 };

test('توزيع البنود: شهري، فواتير فعلية وتقديرية، إهلاك، لكل طلب، ونسبة', () => {
  const rent = allocateDay({ method: 'monthly', amount: 620, startDate: '2026-01-01', active: true }, DAY, {});
  near(rent.amount, 20); assert.equal(rent.basis, 'allocated'); // أكتوبر 31 يوماً
  const elec = { method: 'bills', startDate: '2026-01-01', active: true, bills: [{ from: '2026-08-01', to: '2026-08-31', amount: 93 }, { from: '2026-09-01', to: '2026-09-30', amount: 120 }] };
  const covered = allocateDay(elec, '2026-09-10', {}); near(covered.amount, 4); assert.equal(covered.basis, 'actual');
  const est = allocateDay(elec, DAY, {}); near(est.amount, 213 / 61); assert.equal(est.basis, 'estimated');
  const none = allocateDay({ ...elec, bills: [] }, DAY, {}); assert.equal(none.basis, 'missing');
  const dep = allocateDay({ method: 'depreciation', assetCost: 3720, salvage: 0, lifeMonths: 60, startDate: '2026-01-01', active: true }, DAY, {});
  near(dep.amount, 2); // 3720/60 = 62 شهرياً ÷ 31
  assert.equal(allocateDay({ method: 'depreciation', assetCost: 100, lifeMonths: 6, startDate: '2026-01-01', active: true }, DAY, {}), null, 'انتهى عمر الأصل');
  near(allocateDay({ method: 'per_order', amount: 0.05, startDate: '2026-01-01', active: true }, DAY, { orders: 40 }).amount, 2);
  near(allocateDay({ method: 'percent', percent: 2, percentBase: 'card', startDate: '2026-01-01', active: true }, DAY, { cardSales: 150 }).amount, 3);
  assert.equal(allocateDay({ method: 'monthly', amount: 100, startDate: '2026-11-01', active: true }, DAY, {}), null, 'قبل بدايته');
});

test('العمالة: دوام يتجاوز منتصف الليل يتبع يوم العمل، والإضافي والاستراحة محسوبان', async () => {
  db.reset();
  const ali = await M('Employee').create({ name: 'علي', salary: 416, shiftHours: 8 });   // 416/(26×8) = 2 للساعة
  const sami = await M('Employee').create({ name: 'سامي', hourlyRate: 1.5, shiftHours: 8 });
  const noPay = await M('Employee').create({ name: 'بلا أجر' });
  // علي: 16:00 → 02:00 (10 ساعات) مع استراحة 60 دقيقة = 9 ساعات: 8 عادي + 1 إضافي×1.25 → 18.5
  await M('AttendanceShift').create({ employee: ali._id, employeeName: 'علي', workDay: DAY, status: 'closed', clockInAt: at(DAY, 16), clockOutAt: at(T.addDays(DAY, 1), 2), breaks: [{ startAt: at(DAY, 20), endAt: at(DAY, 21), minutes: 60 }] });
  // سامي: 03:00 → 09:00 — يمتد عبر حد يوم العمل (06:00): 3 ساعات لكل يوم
  await M('AttendanceShift').create({ employee: sami._id, employeeName: 'سامي', workDay: T.addDays(DAY, 1), status: 'closed', clockInAt: at(T.addDays(DAY, 1), 3), clockOutAt: at(T.addDays(DAY, 1), 9) });
  await M('AttendanceShift').create({ employee: noPay._id, employeeName: 'بلا أجر', workDay: DAY, status: 'closed', clockInAt: at(DAY, 10), clockOutAt: at(DAY, 12) });
  const r = await laborForDays([DAY, T.addDays(DAY, 1)], CFG);
  near(r.byDay.get(DAY).cost, 18.5 + 4.5);              // علي كاملاً (الثانية فجراً من نفس اليوم) + نصف سامي
  near(r.byDay.get(T.addDays(DAY, 1)).cost, 4.5);
  const aliRow = r.rows.find((x) => x.name === 'علي');
  assert.equal(aliRow.minutes, 540); assert.equal(aliRow.overtimeMinutes, 60); assert.equal(aliRow.basis, 'allocated');
  assert.equal(r.rows.find((x) => x.name === 'سامي').basis, 'actual');
  assert.deepEqual(r.missing, ['بلا أجر']);
});

async function scenario() {
  db.reset(); cfgSvc.invalidate();
  await M('ProfitConfig').updateOne({ key: 'main' }, { $set: { enabled: true, startedAt: at('2026-10-01', 6), dayStartHour: 6, inventoryExpenseCategories: ['بضاعة'] } }, { upsert: true });
  cfgSvc.invalidate();
  const cat = await M('Category').create({ nameAr: 'سندويشات', name: 'sandwiches' });
  const bread = await inv.createIngredient({ name: 'خبز', baseUnit: 'pc' });
  const meat = await inv.createIngredient({ name: 'لحمة', baseUnit: 'g' });
  await M('ProfitConfig').updateOne({ key: 'main' }, { $set: {} });
  // رصيد افتتاحي: الخبز 0.1 والقطعة، اللحمة 8 دنانير/كغ
  await inv.ingredientMovement({ type: 'opening', ingredient: bread._id, qty: 500, unit: 'pc', unitCost: 0.1 }, { name: 'مروان' });
  await inv.ingredientMovement({ type: 'opening', ingredient: meat._id, qty: 20, unit: 'kg', unitCost: 8 }, { name: 'مروان' });
  const shawarma = await M('Product').create({ nameAr: 'شاورما', price: 2, category: cat._id });
  await inv.saveRecipe({ targetType: 'product', target: shawarma._id, lines: [{ ingredient: bread._id, qty: 1, unit: 'pc' }, { ingredient: meat._id, qty: 100, unit: 'g' }] }); // 0.1 + 0.8 = 0.9
  // مبيعات اليوم: 01:30 فجراً (تتبع اليوم) — 30 شاورما نقداً، و20 كليك بخصم 2 دينار، وطلب ملغى
  const mk = (n, qty, pay, when, extra = {}) => M('Order').create({ orderNumber: String(n), status: 'delivered', source: 'pos', orderType: 'pickup', paymentMethod: pay, items: [{ product: shawarma._id, nameAr: 'شاورما', quantity: qty, price: 2 }], itemsTotal: qty * 2, total: qty * 2 - (extra.discount || 0), createdAt: when, ...extra });
  await mk(1, 30, 'cash', at(DAY, 13));
  await mk(2, 20, 'cliq', at(T.addDays(DAY, 1), 1, 30), { discount: 2 });
  await mk(3, 5, 'cash', at(DAY, 15), { status: 'cancelled' });
  await mk(4, 7, 'cash', at(T.addDays(DAY, 1), 7)); // اليوم التالي
  // عمالة: 416 راتب، 8 ساعات من 12:00 إلى 20:00 = 16
  const emp = await M('Employee').create({ name: 'علي', salary: 416, shiftHours: 8 });
  await M('AttendanceShift').create({ employee: emp._id, employeeName: 'علي', workDay: DAY, status: 'closed', clockInAt: at(DAY, 12), clockOutAt: at(DAY, 20) });
  // بنود: إيجار 620 شهرياً (20 يومياً)
  await M('CostItem').create({ name: 'إيجار المحل', category: 'rent', method: 'monthly', amount: 620, startDate: '2026-01-01' });
  // مصاريف: تنظيف 3 (تشغيلي)، شراء بضاعة 50 (مخزون)، راتب 100 (عمالة من الدوام)، قسط إيجار 20 (التزام)
  const u = await M('User').create({ name: 'مروان', username: 'm', password: 'secret123', role: 'admin' });
  const ex = (name, amount, extra) => M('Expense').create({ number: Math.floor(Math.random() * 1e6), name, amount, createdBy: u._id, source: 'drawer', createdAt: at(DAY, 14), ...extra });
  await ex('منظفات', 3, { category: 'تنظيف' });
  await ex('لحمة', 50, { category: 'بضاعة' });
  await ex('راتب علي', 100, { kind: 'salary', employee: emp._id });
  await ex('قسط الإيجار', 20, { obligation: u._id });
  await ex('ملغى', 9, { category: 'تنظيف', voided: true });
  await cons.runOnce();
  // وجبة موظف + هدر 500غ لحمة + جرد بعجز خبز 5
  await inv.internalUse({ kind: 'staff_meal', employee: emp._id, items: [{ product: shawarma._id, qty: 1 }] }, { name: 'مروان' });
  await inv.ingredientMovement({ type: 'waste', ingredient: meat._id, qty: 500, unit: 'g', reason: 'سقطت على الأرض' }, { name: 'مروان' });
  const c = await inv.createCount({ lines: [{ ingredient: bread._id, counted: 500 - 57 - 1 - 5, unit: 'pc' }] }, { name: 'مروان' });
  await inv.postCount(c._id, { name: 'مروان' });
  // نقل حركات الوجبة والهدر والجرد إلى وقت داخل اليوم المختبر
  for (const m of db.all('StockMovement').filter((x) => ['staff_meal', 'waste', 'count'].includes(x.type))) await M('StockMovement').updateOne({ _id: m._id }, { $set: { at: at(DAY, 18) } });
  for (const s of db.all('SaleCost').filter((x) => x.kind === 'staff_meal')) await M('SaleCost').updateOne({ _id: s._id }, { $set: { at: at(DAY, 18) } });
  return { u, emp };
}

test('قائمة الدخل اليومية: كل رقم محسوب يدوياً، والنقد منفصل عن الربح', async () => {
  await scenario();
  const r = await compute({ from: DAY, to: DAY });
  const L = Object.fromEntries(r.statement.lines.map((l) => [l.key, l]));
  near(L.netSales.amount, 100 - 2);                  // 60 + 40 − خصم 2 (الملغى والطلب التالي خارجاً)
  near(L.cogs.amount, -45);                          // 50 قطعة × 0.9
  near(L.grossProfit.amount, 53);
  near(L.labor.amount, -16);
  near(L.staffMeals.amount, -0.9);
  near(L.ingredientWaste.amount, -4);                // 500غ × 0.008
  near(L.shrinkage.amount, -0.5);                    // 5 أرغفة × 0.1
  const rent = r.statement.lines.find((l) => l.group === 'allocated'); near(rent.amount, -20); assert.equal(rent.basis, 'allocated');
  const opex = r.statement.lines.filter((l) => l.group === 'opex'); assert.equal(opex.length, 1); near(opex[0].amount, -3);
  near(L.operatingProfit.amount, 53 - 16 - 0.9 - 4 - 0.5 - 20 - 3);
  assert.equal(r.statement.kpi.orders, 2);
  near(r.statement.kpi.foodCostPct, 45);             // 45 ÷ 100 (قبل الخصم على الأسطر المكلَّفة)
  assert.ok(L.refunds.note.includes('ملغاة: 1'));
  assert.ok(L.cogs.formula && L.labor.formula && rent.formula.includes('620'), 'كل سطر معه معادلته');
  // النقد: 60 نقد + 38 كليك − (3 + 50 + 100 + 20) = −75 بينما الربح التشغيلي موجب
  const C = Object.fromEntries(r.cash.lines.map((l) => [l.key, l]));
  near(C.netCash.amount, 98 - 173); near(C.outInventory.amount, -50); near(C.outPayroll.amount, -100); near(C.outObligations.amount, -20);
  assert.ok(r.statement.kpi.operatingProfit > 0 && C.netCash.amount < 0, 'ربح محاسبي مع نقد سالب — يُعرضان منفصلين');
  // سلسلة الأيام: اليوم التالي فيه طلب 7 قطع فقط
  const two = await compute({ from: DAY, to: T.addDays(DAY, 1) });
  assert.equal(two.series.length, 2); near(two.series[1].netSales, 14);
});

test('المقارنة والتفسير مبنيان على الأرقام فقط', async () => {
  const cur = { kpi: { netSales: 100, cogs: 40, labor: 20, waste: 2, shrinkage: 0, opex: 5, allocated: 20, operatingProfit: 13 } };
  const prev = { kpi: { netSales: 100, cogs: 34, labor: 16, waste: 2, shrinkage: 0, opex: 5, allocated: 20, operatingProfit: 23 } };
  const e = explainChange(cur, prev, 'نفس اليوم الأسبوع الماضي');
  near(e.diff, -10); near(e.pct, -43.478, 0.01);
  assert.match(e.text, /انخفض الربح التشغيلي 10 دينار/); assert.match(e.text, /ارتفاع تكلفة المواد/); assert.match(e.text, /ارتفاع العمالة/);
  assert.equal(e.drivers.length, 2);
  assert.match(explainChange(cur, { kpi: { netSales: 0, operatingProfit: 0 } }, 'x').text, /لا توجد بيانات/);
});

test('API: الصلاحيات، تقرير الجرد مع مطابقة النقد، التتبع، والتصدير', async () => {
  const { u } = await scenario();
  await M('ShiftSession').create({ shiftId: 'S-1', scope: 'all', status: 'closed', userName: 'كاشير', openedAt: at(DAY, 7), periodStart: at(DAY, 7), closedAt: at(T.addDays(DAY, 1), 3), cashNet: 60, actualCash: 58, cashDiff: -2, diffReason: 'فكة' });
  const mgr = await M('User').create({ name: 'مدير', username: 'mgr', password: 'secret123', role: 'manager' });
  const cashier = await M('User').create({ name: 'كاشير', username: 'c', password: 'secret123', role: 'cashier' });
  const tk = (x) => jwt.sign({ id: String(x._id) }, process.env.JWT_SECRET);
  const app = express(); app.use(express.json()); app.use('/api/profit', require('../profit/routes'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/profit`;
  const call = async (method, url, who, body) => { const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${tk(who)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (_) { j = t; } return { status: r.status, body: j }; };
  try {
    assert.equal((await call('GET', `/report?from=${DAY}&to=${DAY}`, cashier)).status, 403);
    assert.equal((await call('GET', `/report?from=${DAY}&to=${DAY}`, mgr)).status, 403, 'الأرباح لمدير النظام افتراضياً');
    assert.equal((await call('GET', '/ingredients', mgr)).status, 200, 'المدير يدير المخزون');
    assert.equal((await call('POST', '/movements', mgr, { type: 'adjust', ingredient: db.all('Ingredient')[0]._id, qty: 5, unit: 'pc', reason: 'x' })).status, 403, 'تعديل الرصيد لمدير الربحية');
    const rep = await call('GET', `/report?from=${DAY}&to=${DAY}`, u);
    assert.equal(rep.status, 200); near(rep.body.statement.kpi.netSales, 98); assert.ok(rep.body.comparison.explanation.text);
    const sh = await call('GET', '/shifts/S-1', u);
    assert.equal(sh.status, 200); near(sh.body.shift.cash.diff, -2); near(sh.body.statement.kpi.netSales, 98);
    const rent = sh.body.statement.lines.find((l) => l.group === 'allocated');
    assert.ok(Math.abs(rent.amount) < 20 && Math.abs(rent.amount) > 15, 'الإيجار محسوب بنسبة مدة الجرد (20 ساعة من 24)');
    const drill = await call('GET', `/drill?type=saleCosts&from=${DAY}&to=${DAY}`, u);
    assert.equal(drill.body.length, 2); assert.ok(drill.body[0].components.length === 2, 'كل سطر يُتتبع حتى مكوّناته');
    const csv = await call('GET', `/export?type=daily&from=${DAY}&to=${DAY}`, u);
    assert.equal(csv.status, 200); assert.match(String(csv.body), /صافي المبيعات/);
    const cfgPut = await call('PUT', '/config', u, { dayStartHour: 5, lowMarginPct: 40 });
    assert.equal(cfgPut.body.dayStartHour, 5);
    assert.ok(db.all('ActivityLog').some((a) => a.action === 'profit.config'), 'تغيير الإعدادات مسجّل في التدقيق');
    const bad = await call('POST', '/cost-items', u, { name: 'x', method: 'monthly', amount: -5 });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});
