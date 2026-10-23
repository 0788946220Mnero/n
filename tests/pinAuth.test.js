/**
 * دخول الزبون برقم الهاتف + PIN، والإبلاغ عن الرقم واستعادته برمز من سجلات الخادم.
 *   node --test tests/pinAuth.test.js
 */
process.env.JWT_SECRET = 'pin-auth-secret-0123456789abcdef';
delete process.env.PHONE_CLAIM_CALL_NUMBER;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

['PhoneUser', 'PhoneClaim', 'Setting', 'User'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

let server; let base;
let ipN = 0; const nextIp = () => `10.0.0.${++ipN}`; // كل اختبار من «جهاز» مختلف حتى لا يتداخل حد الطلبات
const call = async (method, url, { token, body, ip = '10.9.9.9' } = {}) => {
  const r = await fetch(base + url, {
    method,
    headers: { 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// التقاط سجلات الخادم (ما يظهر في Railway → Logs)
const logs = [];
const origLog = console.log;
console.log = (...a) => { const line = a.join(' '); if (line.includes('PHONE-CLAIM')) logs.push(line); else origLog(...a); };
const codeFromLogs = () => { const m = /رمز الاستعادة: (\d{6})/.exec(logs[logs.length - 1] || ''); return m && m[1]; };

test.before(async () => {
  const app = express(); app.set('trust proxy', true); app.use(express.json());
  app.use('/api/auth', require('../routes/phoneAuthRoutes'));
  app.use('/api/auth', (req, res) => res.status(401).json({ message: 'admin router' }));
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await M('Setting').create({ phones: ['0799000111', '065550000'] });
});
test.after(() => { console.log = origLog; if (server) server.close(); });

test('رقم جديد: لا حساب، ثم إنشاء PIN يرفض السهل ويُنشئ الحساب ويدخل', async () => {
  const ip = nextIp();
  const st = await call('POST', '/api/auth/pin/status', { ip, body: { phone: '0791111111' } });
  assert.equal(st.status, 200);
  assert.equal(st.body.phone, '+962791111111');
  assert.equal(st.body.exists, false);
  assert.equal(st.body.hasPin, false);
  assert.equal((await call('POST', '/api/auth/pin/status', { ip, body: { phone: '12345' } })).status, 400);

  const weak = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '1234' } });
  assert.equal(weak.status, 400); assert.equal(weak.body.code, 'weak_pin');
  assert.equal((await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '12a4' } })).status, 400);
  assert.equal(await M('PhoneUser').countDocuments({ phone: '+962791111111' }), 0, 'الرمز المرفوض لا ينشئ حساباً');

  const ok = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '079 111 1111', pin: '4827' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.isNewUser, true);
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.phone, '+962791111111');
  assert.equal(JSON.stringify(ok.body).includes('pinHash'), false);
  const me = await call('GET', '/api/auth/me', { token: ok.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.phone, '+962791111111');
  assert.equal(JSON.stringify(me.body).includes('pinHash'), false, 'بصمة الرمز لا تخرج أبداً');
  const stored = await M('PhoneUser').findOne({ phone: '+962791111111' }).select('+pinHash').lean();
  assert.match(stored.pinHash, /^[a-f0-9]{32}:[a-f0-9]{64}$/, 'مخزَّن scrypt لا نصاً');
  assert.ok(!stored.pinHash.includes('4827'));

  const st2 = await call('POST', '/api/auth/pin/status', { ip, body: { phone: '+962791111111' } });
  assert.equal(st2.body.exists, true); assert.equal(st2.body.hasPin, true);
});

test('الدخول بالرمز الصحيح، والخطأ يعدّ المحاولات ثم يقفل 15 دقيقة', async () => {
  const ip = nextIp();
  const good = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '4827' } });
  assert.equal(good.status, 200); assert.equal(good.body.isNewUser, false);
  const w1 = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '0007' } });
  assert.equal(w1.status, 401); assert.equal(w1.body.left, 4); assert.match(w1.body.message, /تبقّى 4/);
  for (let i = 0; i < 3; i++) await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '0007' } });
  const lock = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '0007' } });
  assert.equal(lock.status, 423); assert.equal(lock.body.code, 'locked');
  const evenRight = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '4827' } });
  assert.equal(evenRight.status, 423, 'أثناء القفل حتى الرمز الصحيح يُرفض');
  const st = await call('POST', '/api/auth/pin/status', { ip, body: { phone: '0791111111' } });
  assert.ok(st.body.lockedMinutes >= 14);
  await M('PhoneUser').updateOne({ phone: '+962791111111' }, { $set: { pinLockedUntil: new Date(Date.now() - 1000) } });
  assert.equal((await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '4827' } })).status, 200, 'بعد انتهاء القفل يدخل');
});

test('حساب قديم (من أيام رمز التحقق) بلا PIN: أول دخول يضبط رمزه', async () => {
  const ip = nextIp();
  await M('PhoneUser').create({ phone: '+962792222222', isPhoneVerified: true });
  const st = await call('POST', '/api/auth/pin/status', { ip, body: { phone: '0792222222' } });
  assert.equal(st.body.exists, true); assert.equal(st.body.hasPin, false);
  const r = await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0792222222', pin: '5190' } });
  assert.equal(r.status, 200); assert.equal(r.body.pinCreated, true); assert.equal(r.body.isNewUser, false);
  assert.equal((await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0792222222', pin: '5191' } })).status, 401, 'بعدها الرمز مطلوب');
});

test('الإبلاغ: رقم غير مسجّل ← حر للاستخدام؛ رقم مسجّل ← رمز في سجلات الخادم ورقم المطعم للاتصال', async () => {
  const ip = nextIp();
  const free = await call('POST', '/api/auth/pin/report', { ip, body: { phone: '0793333333' } });
  assert.equal(free.status, 404); assert.equal(free.body.code, 'free');

  logs.length = 0;
  const r = await call('POST', '/api/auth/pin/report', { ip, body: { phone: '0791111111', reason: 'taken', note: 'سجّله شخص\nآخر' } });
  assert.equal(r.status, 200);
  assert.match(r.body.ref, /^\d{4}$/);
  assert.equal(r.body.callPhone, '0799000111', 'أول رقم في إعدادات المطعم');
  const days = (new Date(r.body.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7, `صلاحية طويلة: ${days.toFixed(2)} يوم`);
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(r.body).includes(codeFromLogs()), 'الرمز لا يُرسل للزبون أبداً');
  assert.match(logs[0], /\[PHONE-CLAIM\] بلاغ #\d{4} — الرقم 0791111111 — الرقم مسجّل من شخص آخر — رمز الاستعادة: \d{6} — صالح حتى .+ — ملاحظة: سجّله شخص آخر/);
  const claim = await M('PhoneClaim').findOne({ ref: r.body.ref }).lean();
  assert.ok(!('codeHash' in claim), 'بصمة الرمز مخفية في الاستعلام العادي');
  const raw = await M('PhoneClaim').findOne({ ref: r.body.ref }).select('+codeHash').lean();
  assert.ok(!raw.codeHash.includes(codeFromLogs()), 'الرمز نفسه غير مخزَّن');

  const again = await call('POST', '/api/auth/pin/report', { ip, body: { phone: '0791111111' } });
  assert.equal(again.body.ref, r.body.ref); assert.equal(again.body.reused, true);
  assert.equal(logs.length, 1, 'بلاغ مكرر خلال 10 دقائق لا يولّد رمزاً جديداً');
});

test('الاستعادة: رمز خاطئ يُرفض؛ الصحيح يضبط PIN جديداً ويُخرج من سجّل الرقم', async () => {
  const ip = nextIp();
  const intruder = (await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '4827' } })).body.token;
  assert.equal((await call('GET', '/api/auth/me', { token: intruder })).status, 200);
  // اتصال دردشة مفتوح للدخيل
  const rtm = require('../services/customerRealtime');
  const user = await M('PhoneUser').findOne({ phone: '+962791111111' }).lean();
  let closed = null;
  rtm._clients.add({ phoneUserId: String(user._id), community: false, socket: { readyState: 1, send() {}, close: (c) => { closed = c; } } });

  const code = codeFromLogs();
  const wrong = await call('POST', '/api/auth/pin/reclaim', { ip, body: { phone: '0791111111', code: code === '111111' ? '222222' : '111111', pin: '6402' } });
  assert.equal(wrong.status, 400); assert.equal(wrong.body.code, 'wrong_code');
  assert.equal((await call('POST', '/api/auth/pin/reclaim', { ip, body: { phone: '0791111111', code, pin: '1111' } })).body.code, 'weak_pin');

  const ok = await call('POST', '/api/auth/pin/reclaim', { ip, body: { phone: '0791111111', code, pin: '6402' } });
  assert.equal(ok.status, 200); assert.ok(ok.body.token);
  assert.match(logs[logs.length - 1], /استُعيد الرقم 0791111111/);

  const old = await call('GET', '/api/auth/me', { token: intruder });
  assert.equal(old.status, 401, 'توكن من سجّل الرقم لم يعد يعمل'); assert.equal(old.body.code, 'revoked');
  assert.equal(closed, 4001, 'وأُغلقت دردشته المفتوحة فوراً');
  assert.equal((await call('GET', '/api/auth/me', { token: ok.body.token })).status, 200, 'صاحب الرقم داخل');
  assert.equal((await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '4827' } })).status, 401, 'الرمز القديم لا يعمل');
  assert.equal((await call('POST', '/api/auth/pin/login', { ip, body: { phone: '0791111111', pin: '6402' } })).status, 200, 'الرمز الجديد يعمل');

  const reuse = await call('POST', '/api/auth/pin/reclaim', { ip, body: { phone: '0791111111', code, pin: '7713' } });
  assert.equal(reuse.body.code, 'no_claim', 'الرمز يُستخدم مرة واحدة');
});

test('البلاغ المنتهي لا يعمل، و10 محاولات خاطئة تلغي البلاغ', async () => {
  const ip = nextIp();
  await call('POST', '/api/auth/pin/report', { ip, body: { phone: '0792222222', reason: 'forgot' } });
  assert.match(logs[logs.length - 1], /نسي رمز PIN/);
  const code = codeFromLogs();
  await M('PhoneClaim').updateMany({ phone: '+962792222222', status: 'open' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call('POST', '/api/auth/pin/reclaim', { ip, body: { phone: '0792222222', code, pin: '3388' } })).body.code, 'no_claim');

  await M('PhoneClaim').updateMany({ phone: '+962792222222' }, { $set: { createdAt: new Date(Date.now() - 3600 * 1000) } });
  await call('POST', '/api/auth/pin/report', { ip: nextIp(), body: { phone: '0792222222', reason: 'forgot' } });
  const code2 = codeFromLogs();
  const ip2 = nextIp();
  for (let i = 0; i < 10; i++) await call('POST', '/api/auth/pin/reclaim', { ip: ip2, body: { phone: '0792222222', code: code2 === '999999' ? '888888' : '999999', pin: '3388' } });
  const after = await call('POST', '/api/auth/pin/reclaim', { ip: ip2, body: { phone: '0792222222', code: code2, pin: '3388' } });
  assert.equal(after.body.code, 'no_claim', 'أُلغي البلاغ بعد 10 محاولات خاطئة');
});

test('حد الطلبات لكل جهاز: محاولات PIN متتالية كثيرة تُوقف', async () => {
  const ip = nextIp();
  let last;
  for (let i = 0; i < 31; i++) last = await call('POST', '/api/auth/pin/login', { ip, body: { phone: `07955${String(i).padStart(5, '0')}`, pin: '5821' } });
  assert.equal(last.status, 429);
});

test('توكن الأدمن لا يزال يمرّ لراوتر الأدمن على /me', async () => {
  const jwt = require('jsonwebtoken');
  const r = await call('GET', '/api/auth/me', { token: jwt.sign({ id: 'x' }, process.env.JWT_SECRET) });
  assert.equal(r.body.message, 'admin router');
});
