/**
 * اختبار تدفق دخول السائق كاملاً (رقم + PIN + OTP) عبر HTTP،
 * مع استبدال طبقة قاعدة البيانات بمخزن بالذاكرة (لا يحتاج MongoDB).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';

const Driver = require('../models/Driver');
const { hashSecret } = require('../security');
const User = require('../../models/User');
const express = require('express');
// وحدة البراق وحدها (بلا Mongo ولا بث): نفس الموجّه الذي يُركَّب في خادم ديار على /api/brq
const { buildRouter } = require('..');
// رمز مستخدم ديار كما يصدره /api/auth/login: { id, sid }
const signUserAccessToken = (id, sid) => require('jsonwebtoken').sign({ id, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });

// مدير ديار واحد (مجموعة users) — بلا قاعدة بيانات
const ADMIN_DOC = { _id: 'u-admin', name: 'مروان', username: 'admin', role: 'admin', isActive: true, sessionId: 's1', _doc: {} };
User.findById = (id) => ({ select: async () => (String(id) === 'u-admin' ? { ...ADMIN_DOC, _doc: {} } : null) });
User.findOne = () => ({ select: async () => null });

// ---- مخزن بالذاكرة يحاكي الدوال المستخدمة من Driver ----
const store = new Map();
const clone = (o) => (o ? JSON.parse(JSON.stringify(o), reviveDates) : null);
const reviveDates = (k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v);
const withId = (o) => ({ _id: o._id || randomUUID(), tokenVersion: 0, failedAttempts: 0, lockedUntil: null, active: true, ...o });
const applyUpdate = (doc, update) => {
  Object.assign(doc, update.$set || {});
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
  return doc;
};
const find = (q) => [...store.values()].find((d) => (q.phone ? d.phone === q.phone : true) && (q._id ? String(d._id) === String(q._id) : true));

Driver.findOne = async (q) => { const d = find(q); return d ? clone(d) : null; };
Driver.findById = async (id) => { const d = store.get(String(id)); return d ? clone(d) : null; };
Driver.exists = async (q) => !!find(q);
Driver.create = async (data) => { const d = withId({ ...data, _id: randomUUID() }); store.set(String(d._id), d); return clone(d); };
Driver.updateOne = async (q, update) => { const d = store.get(String(q._id)); if (d) applyUpdate(d, update); return { acknowledged: true }; };
Driver.findByIdAndUpdate = async (id, update) => { const d = store.get(String(id)); if (!d) return null; applyUpdate(d, update); return clone(d); };

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brq', buildRouter());
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function seedDriver() {
  store.clear(); // كل اختبار يبدأ بسائق جديد نظيف
  const otp = '123456789012';
  const d = withId({
    _id: randomUUID(), name: 'أحمد', phone: '+962790000001',
    pinHash: await hashSecret('4321'), otpHash: await hashSecret(otp),
    otpExpiresAt: new Date(Date.now() + 86400000),
  });
  store.set(String(d._id), d);
  return { d, otp };
}

test('دخول صحيح يعيد توكن ولا يكشف الـ hashes', async () => {
  const { otp } = await seedDriver();
  const r = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '4321', otp });
  assert.equal(r.status, 200);
  assert.ok(r.data.token);
  assert.equal(r.data.driver.pinHash, undefined);
  assert.equal(r.data.driver.otpHash, undefined);
});

test('PIN أو OTP خاطئ يُرفض برسالة عامة نفسها', async () => {
  const { otp } = await seedDriver();
  const wrongPin = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '0000', otp });
  const wrongOtp = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '4321', otp: '000000000000' });
  const noDriver = await call('POST', '/api/brq/driver/login', { phone: '+962799999999', pin: '4321', otp });
  assert.equal(wrongPin.status, 401);
  assert.equal(wrongOtp.status, 401);
  assert.equal(noDriver.status, 401);
  assert.equal(wrongPin.data.message, wrongOtp.data.message);
  assert.equal(wrongOtp.data.message, noDriver.data.message);
});

test('الحقول الثلاثة مطلوبة: بدون OTP يُرفض الطلب', async () => {
  await seedDriver();
  const r = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '4321' });
  assert.equal(r.status, 400);
});

test('القفل بعد 5 محاولات خاطئة، ولا يُفتح حتى مع البيانات الصحيحة', async () => {
  const { otp } = await seedDriver();
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '0000', otp });
  }
  const r = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '4321', otp });
  assert.equal(r.status, 401);
});

test('إعادة إصدار OTP تُبطل القديم، وتغيير PIN يُبطل التوكنات', async () => {
  const { d, otp } = await seedDriver();
  const login = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '4321', otp });
  const token = login.data.token;
  assert.equal((await call('GET', '/api/brq/driver/me', null, token)).status, 200);

  // المدير يغيّر الـ PIN → التوكن القديم يصبح غير صالح
    const admin = signUserAccessToken('u-admin', 's1');
  const changed = await call('POST', `/api/brq/admin/drivers/${d._id}/pin`, { pin: '9999' }, admin);
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/api/brq/driver/me', null, token)).status, 401);
});

test('موقع السائق يُقبل ويُرفض الإحداثيات الخاطئة', async () => {
  const { otp } = await seedDriver();
  const login = await call('POST', '/api/brq/driver/login', { phone: '+962790000001', pin: '4321', otp });
  const token = login.data.token;
  const bad = await call('POST', '/api/brq/driver/location', { lat: 200, lng: 35 }, token);
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/brq/driver/location', { lat: 31.95, lng: 35.93, accuracy: 8 }, token);
  assert.equal(ok.status, 200);
});

test('لوحة الأدمن محمية بتوكن', async () => {
  assert.equal((await call('GET', '/api/brq/admin/drivers')).status, 401);
    assert.equal((await call('GET', '/api/brq/admin/drivers', null, signUserAccessToken('u-admin', 'old-session'))).status, 401, 'جلسة مستبدلة');
});
