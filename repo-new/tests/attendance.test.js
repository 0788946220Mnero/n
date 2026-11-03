/**
 * الدوام: جهاز حضور موثوق + شبكة المطعم + PIN شخصي + صورة لحظية،
 * والبريك اليدوي من مسؤول القسم (لقسمه فقط)، وحساب الساعات والأيام والاستراحات، واستثناءات المدير.
 */
process.env.JWT_SECRET = 'att-secret-att-secret-att-secret-0001';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Employee', 'AttendanceShift', 'AttendancePhoto', 'AttendanceDevice', 'AttendanceConfig', 'ActivityLog', 'Expense'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const att = require('../services/attendanceService');

let server; let base; const tok = {}; const E = {}; let kiosk = ''; let kiosk2 = '';
const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(900, 7).toString('base64')}`;
const call = async (method, url, { token, body, kioskToken } = {}) => {
  const r = await fetch(base + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(kioskToken ? { 'x-kiosk-token': kioskToken } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch (_) { /* صورة */ }
  return { status: r.status, body: json, headers: r.headers };
};
const punch = (emp, pin, action, extra = {}) => call('POST', '/api/attendance/kiosk/punch', { kioskToken: kiosk, body: { employeeId: String(emp._id), pin, action, photo: PHOTO, ...extra } });
const ago = (m) => new Date(Date.now() - m * 60000);
const hhmm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const freeGate = (emp) => M('Employee').updateOne({ _id: emp._id }, { $set: { lastPunchAt: ago(5) } });

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/attendance', require('../routes/attendanceRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const users = [
    ['admin', 'admin', 'مروان', []],
    ['sup', 'employee', 'أبو خالد (المطبخ)', ['attendance:breaks']],
    ['sup2', 'employee', 'سامر (المطبخ)', ['attendance:breaks']],
    ['observer', 'observer', 'المراقب', []],
    ['cashier', 'cashier', 'الكاشير', []],
  ];
  for (const [k, role, name, permissions] of users) {
    const u = await M('User').create({ name, username: k, password: 'secret123', role, isActive: true, permissions });
    tok[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
    E['u_' + k] = u;
  }
  E.ahmad = await M('Employee').create({ name: 'أحمد', jobTitle: 'طبّاخ', section: 'المطبخ', salary: 400, shiftHours: 8, shiftStart: hhmm(ago(30)) });
  E.lina = await M('Employee').create({ name: 'لينا', jobTitle: 'كاشير', section: 'الكاشير', salary: 350 });
  E.omar = await M('Employee').create({ name: 'عمر', jobTitle: 'مساعد', section: 'المطبخ' });
});
test.after(() => server.close());

test('أدوات: الشبكة (IP و CIDR) والرموز الضعيفة', () => {
  assert.equal(att.ipAllowed('::ffff:192.168.1.20', ['192.168.1.0/24']), true);
  assert.equal(att.ipAllowed('192.168.2.20', ['192.168.1.0/24']), false);
  assert.equal(att.ipAllowed('85.1.2.3', ['85.1.2.3']), true);
  assert.equal(att.ipAllowed('85.1.2.4', []), true, 'بلا قائمة = بلا قيد');
  for (const p of ['1234', '0000', '9876', '12', 'abcd', '1234567']) assert.ok(att.weakPin(p), p);
  assert.equal(att.weakPin('4071'), '');
});

test('رموز PIN: المدير يعيّنها، ومسؤول القسم لا', async () => {
  assert.equal((await call('POST', `/api/attendance/employees/${E.ahmad._id}/pin`, { token: tok.sup, body: {} })).status, 403);
  assert.equal((await call('POST', `/api/attendance/employees/${E.ahmad._id}/pin`, { token: tok.admin, body: { pin: '1111' } })).status, 400);
  const r = await call('POST', `/api/attendance/employees/${E.ahmad._id}/pin`, { token: tok.admin, body: {} });
  assert.equal(r.status, 200);
  assert.match(r.body.pin, /^\d{4}$/); assert.equal(att.weakPin(r.body.pin), '');
  E.ahmadPin = r.body.pin;
  E.linaPin = (await call('POST', `/api/attendance/employees/${E.lina._id}/pin`, { token: tok.admin, body: { pin: '5820' } })).body.pin;
  E.omarPin = (await call('POST', `/api/attendance/employees/${E.omar._id}/pin`, { token: tok.admin, body: { pin: '3917' } })).body.pin;
  const stored = await M('Employee').findById(E.ahmad._id).select('+pinHash').lean();
  assert.ok(stored.pinHash && stored.pinHash !== E.ahmadPin, 'يُحفظ مشفراً');
  const list = await M('Employee').findById(E.ahmad._id).lean();
  assert.equal(list.pinHash, undefined, 'لا يخرج الرمز في القوائم');
});

test('جهاز الحضور: ربط برمز مؤقت لمرة واحدة، وبلا مفتاح لا شيء', async () => {
  assert.equal((await call('GET', '/api/attendance/kiosk/state')).status, 401);
  assert.equal((await call('POST', '/api/attendance/devices', { token: tok.sup, body: { name: 'x' } })).status, 403);
  const d = await call('POST', '/api/attendance/devices', { token: tok.admin, body: { name: 'تابلت الباب' } });
  assert.equal(d.status, 201); assert.match(d.body.code, /^\d{8}$/);
  assert.equal((await call('POST', '/api/attendance/kiosk/pair', { body: { code: '00000000' } })).status, 400);
  const p = await call('POST', '/api/attendance/kiosk/pair', { body: { code: d.body.code } });
  assert.equal(p.status, 200); kiosk = p.body.token;
  assert.equal((await call('POST', '/api/attendance/kiosk/pair', { body: { code: d.body.code } })).status, 400, 'الرمز لمرة واحدة');
  const s = await call('GET', '/api/attendance/kiosk/state', { kioskToken: kiosk });
  assert.equal(s.status, 200); assert.equal(s.body.device.name, 'تابلت الباب');
  const a = s.body.employees.find((x) => x.name === 'أحمد');
  assert.equal(a.state, 'off'); assert.equal(a.hasPin, true); assert.equal(a.pinHash, undefined);
  // جهاز ثانٍ يُلغى فيُقطع فوراً
  const d2 = await call('POST', '/api/attendance/devices', { token: tok.admin, body: { name: 'مؤقت' } });
  kiosk2 = (await call('POST', '/api/attendance/kiosk/pair', { body: { code: d2.body.code } })).body.token;
  assert.equal((await call('GET', '/api/attendance/kiosk/state', { kioskToken: kiosk2 })).status, 200);
  assert.equal((await call('DELETE', `/api/attendance/devices/${d2.body.device.id}`, { token: tok.admin })).status, 200);
  assert.equal((await call('GET', '/api/attendance/kiosk/state', { kioskToken: kiosk2 })).status, 401);
});

test('شبكة المطعم: خارجها مرفوض حتى بمفتاح صحيح', async () => {
  await call('PUT', '/api/attendance/config', { token: tok.admin, body: { allowedIps: ['10.0.0.0/8'] } });
  const r = await call('GET', '/api/attendance/kiosk/state', { kioskToken: kiosk });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'KIOSK_NETWORK');
  await call('PUT', '/api/attendance/config', { token: tok.admin, body: { allowedIps: ['127.0.0.1'] } });
  assert.equal((await call('GET', '/api/attendance/kiosk/state', { kioskToken: kiosk })).status, 200);
});

test('الحضور: الرمز الخاطئ يُقفل بعد 3، الصورة مطلوبة، والتأخير يُرصد', async () => {
  const w1 = await punch(E.ahmad, '9999', 'in');
  assert.equal(w1.status, 401); assert.match(w1.body.message, /بقي 2/);
  await punch(E.ahmad, '9998', 'in');
  const w3 = await punch(E.ahmad, '9997', 'in');
  assert.equal(w3.status, 423);
  assert.equal((await punch(E.ahmad, E.ahmadPin, 'in')).status, 423, 'مقفل حتى بالرمز الصحيح');
  assert.equal((await call('POST', `/api/attendance/employees/${E.ahmad._id}/unlock`, { token: tok.admin })).status, 200);
  assert.equal((await punch(E.ahmad, E.ahmadPin, 'in', { photo: '' })).status, 400, 'بلا صورة');
  const ok = await punch(E.ahmad, E.ahmadPin, 'in');
  assert.equal(ok.status, 200); assert.equal(ok.body.action, 'in');
  assert.equal(ok.body.mustChangePin, true, 'رمز عيّنه المدير يُغيَّر');
  assert.ok(ok.body.shift.lateMinutes >= 25, `تأخير ${ok.body.shift.lateMinutes}`);
  assert.equal((await punch(E.ahmad, E.ahmadPin, 'in')).status, 409, 'لا حضور مرتين');
  assert.equal((await punch(E.ahmad, E.ahmadPin, 'out')).status, 429, 'ضغطة ثانية خلال دقيقة');
});

test('تغيير الرمز من جهاز الحضور: لا ضعيف ولا مكرر، والقديم يبطل', async () => {
  const body = (newPin) => ({ employeeId: String(E.ahmad._id), pin: E.ahmadPin, newPin });
  assert.equal((await call('POST', '/api/attendance/kiosk/pin', { kioskToken: kiosk, body: body('2222') })).status, 400);
  assert.equal((await call('POST', '/api/attendance/kiosk/pin', { kioskToken: kiosk, body: body(E.ahmadPin) })).status, 400);
  assert.equal((await call('POST', '/api/attendance/kiosk/pin', { kioskToken: kiosk, body: body('6048') })).status, 200);
  E.oldPin = E.ahmadPin; E.ahmadPin = '6048';
  const emp = await M('Employee').findById(E.ahmad._id).lean();
  assert.equal(emp.pinMustChange, false);
});

test('جهازان في نفس اللحظة: حضور واحد فقط', async () => {
  const [a, b] = await Promise.all([punch(E.omar, E.omarPin, 'in'), punch(E.omar, E.omarPin, 'in')]);
  const st = [a.status, b.status].sort();
  assert.equal(st[0], 200); assert.ok([409, 429].includes(st[1]), `الثاني مرفوض (${st[1]})`);
  assert.equal(await M('AttendanceShift').countDocuments({ employee: E.omar._id, status: 'open' }), 1);
  await punch(E.lina, E.linaPin, 'in');
});

test('البريك من مسؤول القسم: لقسمه فقط، بريك واحد مفتوح، والسابق بلا تداخل', async () => {
  await call('PUT', '/api/attendance/config', { token: tok.admin, body: { supervisors: [{ user: String(E.u_sup._id), sections: ['المطبخ'] }, { user: String(E.u_sup2._id), sections: ['المطبخ'] }] } });
  // حضور أحمد قبل 4 ساعات (لاختبار الحسابات)
  await M('AttendanceShift').updateOne({ employee: E.ahmad._id, status: 'open' }, { $set: { clockInAt: ago(240) } });
  const lv = await call('GET', '/api/attendance/live', { token: tok.sup });
  assert.equal(lv.status, 200);
  assert.deepEqual(lv.body.shifts.map((s) => s.employeeName).sort(), ['أحمد', 'عمر'], 'لا يرى لينا (الكاشير)');
  const ahmadShift = lv.body.shifts.find((s) => s.employeeName === 'أحمد').id;
  E.ahmadShift = ahmadShift;
  const linaShift = (await M('AttendanceShift').findOne({ employee: E.lina._id }).lean())._id;
  assert.equal((await call('POST', `/api/attendance/shifts/${linaShift}/breaks/start`, { token: tok.sup, body: {} })).status, 403);
  assert.equal((await call('GET', '/api/attendance/live', { token: tok.cashier })).status, 403);

  // بريك سابق: من قبل ساعتين لمدة 20 دقيقة
  const past = await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks`, { token: tok.sup, body: { startAt: ago(120).toISOString(), minutes: 20, note: 'غداء' } });
  assert.equal(past.status, 201); assert.equal(past.body.shift.breakMinutes, 20);
  assert.equal((await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks`, { token: tok.sup, body: { startAt: ago(110).toISOString(), minutes: 5 } })).status, 409, 'تداخل');
  assert.equal((await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks`, { token: tok.sup, body: { startAt: ago(300).toISOString(), minutes: 5 } })).status, 400, 'قبل الحضور');
  assert.equal((await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks`, { token: tok.sup, body: { startAt: ago(3).toISOString(), minutes: 10 } })).status, 400, 'ينتهي في المستقبل');

  // بريك الآن
  const st = await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks/start`, { token: tok.sup, body: { note: 'صلاة' } });
  assert.equal(st.status, 200); assert.ok(st.body.shift.onBreak);
  assert.equal((await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks/start`, { token: tok.sup2, body: {} })).status, 409, 'بريك واحد مفتوح');
  // نُرجع بداية البريك 12 دقيقة ثم ننهيه
  await M('AttendanceShift').updateOne({ _id: ahmadShift }, { $set: { 'breaks.1.startAt': ago(12) } });
  const en = await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks/end`, { token: tok.sup2 });
  assert.equal(en.status, 200); assert.equal(en.body.shift.onBreak, null);
  assert.equal(en.body.shift.breakCount, 2); assert.equal(en.body.shift.breakMinutes, 32);
  assert.equal(en.body.shift.breaks[1].endedByName, 'سامر (المطبخ)');
  // بريك خاطئ: الآخر لا يحذف ما سجّله غيره، وصاحبه يحذفه
  const wrong = await call('POST', `/api/attendance/shifts/${ahmadShift}/breaks`, { token: tok.sup, body: { startAt: ago(60).toISOString(), minutes: 3 } });
  const wid = wrong.body.shift.breaks.find((b) => b.minutes === 3).id;
  assert.equal((await call('DELETE', `/api/attendance/shifts/${ahmadShift}/breaks/${wid}`, { token: tok.sup2 })).status, 403);
  const del = await call('DELETE', `/api/attendance/shifts/${ahmadShift}/breaks/${wid}`, { token: tok.sup });
  assert.equal(del.status, 200); assert.equal(del.body.shift.breakMinutes, 32);
});

test('الانصراف: الساعات = الإجمالي − البريك، والبريك المفتوح يُغلق تلقائياً', async () => {
  await call('POST', `/api/attendance/shifts/${E.ahmadShift}/breaks/start`, { token: tok.sup, body: {} });
  await M('AttendanceShift').updateOne({ _id: E.ahmadShift }, { $set: { 'breaks.2.startAt': ago(8) } });
  await freeGate(E.ahmad);
  const out = await punch(E.ahmad, E.ahmadPin, 'out');
  assert.equal(out.status, 200); assert.equal(out.body.action, 'out');
  assert.equal(out.body.shift.breakMinutes, 40);
  assert.equal(out.body.shift.workedMinutes, 240 - 40);
  const s = await M('AttendanceShift').findById(E.ahmadShift).lean();
  assert.equal(s.breaks[2].endedByName, 'الانصراف');
  assert.equal((await call('POST', `/api/attendance/shifts/${E.ahmadShift}/breaks/start`, { token: tok.sup, body: {} })).status, 409, 'لا بريك بعد الانصراف');
  assert.equal((await punch(E.ahmad, E.oldPin, 'in')).status, 401, 'الرمز القديم لا يعمل');
});

test('سجل الموظف والتقرير: الأيام والساعات والاستراحات بالدقيقة', async () => {
  // يوم سابق مغلق (بالمدير) لأحمد: 6 ساعات
  const y = new Date(Date.now() - 864e5);
  const man = await call('POST', '/api/attendance/shifts', { token: tok.admin, body: { employeeId: String(E.ahmad._id), clockInAt: new Date(y - 6 * 3600e3).toISOString(), clockOutAt: y.toISOString(), reason: 'نسي التسجيل' } });
  assert.equal(man.status, 201); assert.ok(man.body.shift.flags.includes('manual'));
  const from = att.ammanDay(new Date(Date.now() - 3 * 864e5));
  const rec = await call('GET', `/api/attendance/employees/${E.ahmad._id}?from=${from}`, { token: tok.observer });
  assert.equal(rec.status, 200, 'مراقب البيانات يرى السجل');
  assert.equal(rec.body.summary.days, 2);
  assert.equal(rec.body.summary.shifts, 2);
  assert.equal(rec.body.summary.workedMinutes, 200 + 360);
  assert.equal(rec.body.summary.breakMinutes, 40);
  assert.equal(rec.body.summary.breakCount, 3);
  assert.equal(rec.body.summary.lateCount, 1);
  assert.equal((await call('GET', `/api/attendance/employees/${E.ahmad._id}`, { token: tok.cashier })).status, 403);
  assert.equal((await call('GET', `/api/attendance/employees/${E.ahmad._id}`, { token: tok.sup })).status, 200, 'مسؤول القسم يرى موظف قسمه');
  assert.equal((await call('GET', `/api/attendance/employees/${E.lina._id}`, { token: tok.sup })).status, 403, 'ولا يرى غير قسمه');
  const rep = await call('GET', `/api/attendance/report?from=${from}`, { token: tok.admin });
  const row = rep.body.rows.find((r) => r.name === 'أحمد');
  assert.equal(row.workedMinutes, 560); assert.equal(row.days, 2);
  const supRep = await call('GET', `/api/attendance/report?from=${from}`, { token: tok.sup });
  assert.ok(!supRep.body.rows.some((r) => r.name === 'لينا'), 'المسؤول يرى قسمه فقط');
});

test('الاستثناءات: التأخير والنسيان والتعديل اليدوي، والاعتماد يخفيها، والصور للمدير', async () => {
  // لينا نسيت الانصراف: حضورها قبل 20 ساعة
  await M('AttendanceShift').updateOne({ employee: E.lina._id, status: 'open' }, { $set: { clockInAt: ago(20 * 60) } });
  assert.equal((await call('GET', '/api/attendance/exceptions', { token: tok.sup })).status, 403);
  const ex = await call('GET', '/api/attendance/exceptions', { token: tok.admin });
  assert.equal(ex.status, 200);
  const byName = (n) => ex.body.shifts.filter((s) => s.employeeName === n);
  assert.ok(byName('لينا')[0].flags.includes('forgot_out'));
  const late = byName('أحمد').find((s) => s.flags.includes('late'));
  assert.ok(late && late.inPhoto, 'معه صورة الحضور');
  assert.ok(ex.body.lockouts.some((l) => l.employee === 'أحمد'), 'القفل بسبب رمز خاطئ يظهر');
  // الصورة: للمدير فقط
  const ph = await fetch(`${base}/api/attendance/photos/${late.inPhoto}`, { headers: { Authorization: `Bearer ${tok.admin}` } });
  assert.equal(ph.status, 200); assert.equal(ph.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/api/attendance/photos/${late.inPhoto}`, { headers: { Authorization: `Bearer ${tok.sup}` } })).status, 403);
  // إغلاق دوام لينا: بسبب فقط
  const linaShift = byName('لينا')[0].id;
  assert.equal((await call('POST', `/api/attendance/shifts/${linaShift}/close`, { token: tok.admin, body: {} })).status, 400);
  const cl = await call('POST', `/api/attendance/shifts/${linaShift}/close`, { token: tok.admin, body: { at: ago(12 * 60).toISOString(), reason: 'نسيت — اتصلت بها' } });
  assert.equal(cl.status, 200); assert.equal(cl.body.shift.workedMinutes, 8 * 60);
  // اعتماد التأخير يخفيه، وتعديله لاحقاً يعيده
  assert.equal((await call('POST', `/api/attendance/shifts/${late.id}/review`, { token: tok.admin, body: { note: 'زحمة سير' } })).status, 200);
  let ex2 = await call('GET', '/api/attendance/exceptions', { token: tok.admin });
  assert.ok(!ex2.body.shifts.some((s) => s.id === late.id));
  assert.equal((await call('PUT', `/api/attendance/shifts/${late.id}`, { token: tok.admin, body: { clockInAt: ago(230).toISOString() } })).status, 400, 'بلا سبب');
  assert.equal((await call('PUT', `/api/attendance/shifts/${late.id}`, { token: tok.admin, body: { clockInAt: ago(100).toISOString(), reason: 'x' } })).status, 400, 'استراحة خارج الوقت الجديد');
  const ed = await call('PUT', `/api/attendance/shifts/${late.id}`, { token: tok.admin, body: { clockInAt: ago(250).toISOString(), reason: 'حضر قبل التسجيل' } });
  assert.equal(ed.status, 200); assert.equal(ed.body.shift.workedMinutes, 250 - 40);
  ex2 = await call('GET', '/api/attendance/exceptions', { token: tok.admin });
  assert.ok(ex2.body.shifts.find((s) => s.id === late.id).flags.includes('manual'));
});
