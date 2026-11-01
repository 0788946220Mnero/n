/**
 * الدوام (الإضافات): أي مدير يسجّل الاستراحات، ومن يضيفه المدير «مسؤول قسم» بلا صلاحية؛
 * دوام منسي يُغلق كنصف دوام أو عطلة؛ تسجيل عطلة لتاريخ؛ تنبيه دوام > 11 ساعة واستراحة مفتوحة (مرة واحدة)؛
 * تصفية الموظف: الدوامات والاستراحات والعطل والراتب والمصاريف تُصفّر وتُحفظ في الأرشيف، ولا تُعدّل بعدها؛
 * الطباعة: مهمة html إلى محطة الطباعة.
 */
process.env.JWT_SECRET = 'set-secret-set-secret-set-secret-0001';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Employee', 'AttendanceShift', 'AttendancePhoto', 'AttendanceDevice', 'AttendanceConfig', 'ActivityLog', 'Expense', 'EmployeeSettlement', 'Counter', 'PrintJob', 'Setting', 'StaffAlert', 'StaffDevice'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const att = require('../services/attendanceService');

let server; let base; const tok = {}; const E = {}; const U = {};
const call = async (method, url, token, body) => {
  const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ago = (m) => new Date(Date.now() - m * 60000);
const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(d);
const openShift = (emp, minutesAgo, extra = {}) => M('AttendanceShift').create({ employee: emp._id, employeeName: emp.name, section: emp.section, workDay: day(ago(minutesAgo)), status: 'open', clockInAt: ago(minutesAgo), ...extra });
const pay = (emp, kind, amount) => M('Expense').create({ number: Math.floor(Math.random() * 1e6), name: `${kind} ${emp.name}`, amount, kind, employee: emp._id, employeeName: emp.name, category: 'رواتب', source: 'drawer', createdBy: U.admin._id, createdByName: 'مروان' });

test.before(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/attendance', require('../routes/attendanceRoutes'));
  app.use('/api/expenses', require('../routes/expenseRoutes'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, role, perms] of [['admin', 'admin', []], ['manager', 'manager', []], ['cashier', 'cashier', []], ['emp', 'employee', []], ['customMgr', 'manager', ['orders:manage']]]) {
    U[k] = await M('User').create({ name: k, username: k, password: 'secret123', role, isActive: true, permissions: perms });
    tok[k] = jwt.sign({ id: String(U[k]._id) }, process.env.JWT_SECRET);
  }
  E.ahmad = await M('Employee').create({ name: 'أحمد', section: 'المطبخ', salary: 400, shiftHours: 8 });
  E.lina = await M('Employee').create({ name: 'لينا', section: 'الكاشير', salary: 300 });
  E.omar = await M('Employee').create({ name: 'عمر', section: 'المطبخ', salary: 250, shiftHours: 10 });
});
test.after(() => server.close());

test('البريك: أي «مدير» (حتى بصلاحيات مخصّصة) — والكاشير لا، إلا إن أضافه المدير مسؤول قسم', async () => {
  const s = await openShift(E.ahmad, 120);
  E.ahmadShift = String(s._id);
  assert.equal((await call('POST', `/api/attendance/shifts/${s._id}/breaks/start`, tok.customMgr, {})).status, 200, 'مدير بصلاحيات مخصّصة بلا مفتاح الدوام');
  assert.equal((await call('POST', `/api/attendance/shifts/${s._id}/breaks/end`, tok.manager)).status, 200);
  assert.equal((await call('POST', `/api/attendance/shifts/${s._id}/breaks/start`, tok.cashier, {})).status, 403);
  const acc0 = (await call('GET', '/api/attendance/access', tok.cashier)).body.access;
  assert.equal(acc0.breaks, false);
  // المدير يضيف الكاشير مسؤولاً عن المطبخ — بلا تعديل صلاحياته
  const cand = (await call('GET', '/api/attendance/config', tok.admin)).body.candidates;
  assert.ok(cand.some((c) => c.id === String(U.cashier._id)), 'أي مستخدم مرشّح');
  await call('PUT', '/api/attendance/config', tok.admin, { supervisors: [{ user: String(U.cashier._id), sections: ['المطبخ'] }] });
  const acc = (await call('GET', '/api/attendance/access', tok.cashier)).body.access;
  assert.equal(acc.breaks, true); assert.deepEqual(acc.scope, ['المطبخ']); assert.equal(acc.manage, false);
  assert.equal((await call('POST', `/api/attendance/shifts/${s._id}/breaks/start`, tok.cashier, { note: 'غداء' })).status, 200);
  const linaShift = await openShift(E.lina, 60);
  assert.equal((await call('POST', `/api/attendance/shifts/${linaShift._id}/breaks/start`, tok.cashier, {})).status, 403, 'لقسمه فقط');
  E.linaShift = String(linaShift._id);
  // النطاق: المدير يرى الكل
  const live = (await call('GET', '/api/attendance/live', tok.manager)).body;
  assert.equal(live.scope, null); assert.equal(live.shifts.length, 2);
  assert.equal(live.maxShiftHours, 11);
});

test('التنبيهات: استراحة مفتوحة طويلة ودوام > 11 ساعة — كلٌّ مرة واحدة', async () => {
  await M('AttendanceShift').updateOne({ _id: E.ahmadShift }, { $set: { 'breaks.1.startAt': ago(45) } });
  const omar = await openShift(E.omar, 11 * 60 + 5);
  E.omarShift = String(omar._id);
  const first = await att.checkAlerts();
  assert.deepEqual(first.map((x) => x.type).sort(), ['break', 'long']);
  assert.ok(first.find((x) => x.type === 'long').employee === 'عمر');
  assert.equal((await att.checkAlerts()).length, 0, 'لا تكرار');
  const lv = (await call('GET', '/api/attendance/live', tok.admin)).body.shifts.find((x) => x.id === E.omarShift);
  assert.equal(lv.longOpen, true); assert.ok(lv.flags.includes('forgot_out'));
});

test('دوام منسي: المدير يغلقه كنصف دوام أو عطلة — بسبب', async () => {
  assert.equal((await call('POST', `/api/attendance/shifts/${E.omarShift}/close`, tok.cashier, { mode: 'half', reason: 'x' })).status, 403);
  assert.equal((await call('POST', `/api/attendance/shifts/${E.omarShift}/close`, tok.admin, { mode: 'half' })).status, 400, 'بلا سبب');
  const h = await call('POST', `/api/attendance/shifts/${E.omarShift}/close`, tok.admin, { mode: 'half', reason: 'نسي الانصراف' });
  assert.equal(h.status, 200);
  assert.equal(h.body.shift.dayType, 'half'); assert.equal(h.body.shift.workedMinutes, 300, 'نصف 10 ساعات');
  assert.ok(h.body.shift.flags.includes('half_day'));
  const o = await call('POST', `/api/attendance/shifts/${E.linaShift}/close`, tok.manager, { mode: 'off', reason: 'لم يحضر فعلياً' });
  assert.equal(o.status, 200); assert.equal(o.body.shift.dayType, 'off'); assert.equal(o.body.shift.workedMinutes, 0);
});

test('تسجيل عطلة لتاريخ، ولا تكرار في يوم فيه دوام، وحذفها قبل التصفية', async () => {
  const y = day(ago(26 * 60));
  const r = await call('POST', '/api/attendance/days', tok.admin, { employeeId: String(E.ahmad._id), day: y, kind: 'off', reason: 'إجازة' });
  assert.equal(r.status, 201); assert.equal(r.body.shift.dayType, 'off');
  assert.equal((await call('POST', '/api/attendance/days', tok.admin, { employeeId: String(E.ahmad._id), day: y, kind: 'half', reason: 'x' })).status, 409);
  const extra = await call('POST', '/api/attendance/days', tok.admin, { employeeId: String(E.ahmad._id), day: day(ago(50 * 60)), kind: 'off', reason: 'خطأ' });
  assert.equal((await call('DELETE', `/api/attendance/days/${extra.body.shift.id}`, tok.admin)).status, 200);
  assert.equal((await call('POST', '/api/attendance/days', tok.admin, { employeeId: String(E.ahmad._id), day: '2099-01-01', kind: 'off', reason: 'x' })).status, 400);
});

test('الملف الكامل والتصفية: كل شيء يُصفّر ويُحفظ، والدوام المفتوح يبقى', async () => {
  // أحمد: دوام مغلق 6 ساعات أمس + الدوام المفتوح الآن (في استراحة) + عطلة + سلفة وراتب جزئي
  await M('AttendanceShift').create({ employee: E.ahmad._id, employeeName: 'أحمد', section: 'المطبخ', workDay: day(ago(30 * 60)), status: 'closed', clockInAt: ago(30 * 60), clockOutAt: ago(24 * 60), workedMinutes: 340, breakMinutes: 20, breaks: [{ startAt: ago(28 * 60), endAt: ago(28 * 60 - 20), minutes: 20, byName: 'm' }] });
  await pay(E.ahmad, 'advance', 50); await pay(E.ahmad, 'salary', 200);
  const voidMe = await pay(E.ahmad, 'bonus', 10);
  await M('Expense').updateOne({ _id: voidMe._id }, { $set: { voided: true } });

  const f = (await call('GET', `/api/attendance/employees/${E.ahmad._id}/full`, tok.admin)).body;
  assert.equal(f.period.summary.days, 2); assert.equal(f.period.summary.offDays, 1);
  assert.equal(f.period.paid.advance, 50); assert.equal(f.period.paid.salary, 200); assert.equal(f.period.paid.bonus, 0, 'الملغى خارج');
  assert.equal(f.period.remaining, 150);
  // مسؤول القسم يرى الدوام لا الراتب والمصاريف
  const sf = (await call('GET', `/api/attendance/employees/${E.ahmad._id}/full`, tok.cashier)).body;
  assert.equal(sf.employee.salary, null); assert.equal(sf.period.payments, undefined);
  assert.equal((await call('GET', `/api/attendance/employees/${E.lina._id}/full`, tok.cashier)).status, 403);
  // التصفية: المدير (بلا employees:pay افتراضياً لكن له employees:manage) ومدير النظام — لا الكاشير
  assert.equal((await call('POST', `/api/attendance/employees/${E.ahmad._id}/settle`, tok.cashier, {})).status, 403);
  const st = await call('POST', `/api/attendance/employees/${E.ahmad._id}/settle`, tok.admin, { note: 'تصفية أكتوبر' });
  assert.equal(st.status, 201);
  const S = st.body.settlement;
  assert.equal(S.number, 1); assert.equal(S.summary.days, 1, 'الدوام المغلق فقط'); assert.equal(S.summary.offDays, 1);
  assert.equal(S.summary.breakMinutes, 20); assert.equal(S.paid.all, 250); assert.equal(S.remaining, 150);
  assert.equal(S.shifts.length, 2); assert.equal(S.payments.length, 2);
  // بعد التصفية: الفترة الجارية صفر إلا الدوام المفتوح
  const f2 = (await call('GET', `/api/attendance/employees/${E.ahmad._id}/full`, tok.admin)).body;
  assert.equal(f2.period.paid.all, 0); assert.equal(f2.period.remaining, 400);
  assert.equal(f2.period.shifts.length, 1); assert.equal(f2.period.shifts[0].status, 'open');
  assert.equal(f2.settlements.length, 1); assert.ok(f2.employee.lastSettledAt);
  // الأرشيف يُفتح، والمصفّى لا يُعدّل ولا يُلغى
  const g = await call('GET', `/api/attendance/settlements/${S._id}`, tok.manager);
  assert.equal(g.status, 200); assert.equal(g.body.settlement.payments.length, 2);
  const settledShift = (await M('AttendanceShift').find({ settlement: S._id }).lean()).find((x) => x.dayType !== 'off');
  assert.equal((await call('PUT', `/api/attendance/shifts/${settledShift._id}`, tok.admin, { clockInAt: ago(31 * 60).toISOString(), reason: 'x' })).status, 409);
  const settledPay = await M('Expense').findOne({ settlement: S._id }).lean();
  const vd = await call('PATCH', `/api/expenses/${settledPay._id}/void`, tok.admin);
  assert.equal(vd.status, 400, 'لا يُلغى الصرف المصفّى'); assert.match(vd.body.message, /تصفية/);
  // لا شيء جديد ← لا تصفية فارغة
  assert.equal((await call('POST', `/api/attendance/employees/${E.ahmad._id}/settle`, tok.admin, {})).status, 400);
  // قائمة الموظفين بأرقام الفترة الجارية
  const ov = (await call('GET', '/api/attendance/employees', tok.admin)).body.rows;
  const a = ov.find((x) => x.name === 'أحمد');
  assert.equal(a.onDuty, true); assert.equal(a.paid.all, 0); assert.ok(a.lastSettledAt);
});

test('الطباعة: مهمة html لمحطة الطباعة بالكشف والتصفية والتقرير', async () => {
  const p1 = await call('POST', `/api/attendance/employees/${E.omar._id}/print`, tok.manager);
  assert.equal(p1.status, 200);
  const j1 = await M('PrintJob').findById(p1.body.jobId).lean();
  assert.equal(j1.type, 'html'); assert.equal(j1.status, 'pending');
  assert.match(j1.payload.html, /كشف دوام وحساب موظف/); assert.match(j1.payload.html, /عمر/); assert.match(j1.payload.html, /نصف/);
  assert.match(j1.payload.html, /المتبقي من الراتب/);
  const s = await M('EmployeeSettlement').findOne().lean();
  const p2 = await call('POST', `/api/attendance/settlements/${s._id}/print`, tok.admin);
  assert.match((await M('PrintJob').findById(p2.body.jobId).lean()).payload.html, /تصفية موظف #1/);
  const p3 = await call('POST', '/api/attendance/report/print', tok.admin, {});
  assert.match((await M('PrintJob').findById(p3.body.jobId).lean()).payload.html, /تقرير الدوام/);
  // مسؤول القسم يطبع كشف موظف قسمه بلا الراتب
  const p4 = await call('POST', `/api/attendance/employees/${E.omar._id}/print`, tok.cashier);
  assert.equal(p4.status, 200);
  assert.doesNotMatch((await M('PrintJob').findById(p4.body.jobId).lean()).payload.html, /المتبقي من الراتب/);
});
