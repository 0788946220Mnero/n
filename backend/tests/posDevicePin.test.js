/**
 * رمز إعدادات أجهزة الكاشير: مدير النظام وحده يعيّنه، أجهزة البيع تقرأ بصمته (لا الرمز) لتتحقق بلا إنترنت.
 */
process.env.JWT_SECRET = 'pin-secret-pin-secret-pin-secret-0001';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'PosDeviceConfig', 'ActivityLog'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { weakPin } = require('../routes/posDeviceRoutes');

let server; let base; const tok = {};
const call = async (method, url, token, body) => {
  const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test.before(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/pos-devices', require('../routes/posDeviceRoutes'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['admin', 'manager', 'cashier', 'waiter', 'center']) {
    const u = await M('User').create({ name: role, username: role, password: 'secret123', role, isActive: true });
    tok[role] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  }
});
test.after(() => server.close());

test('الرموز الضعيفة مرفوضة', () => {
  for (const p of ['1234', '123456', '654321', '000000', '121212', '123123', 'abcdef', '123456789']) assert.ok(weakPin(p), p);
  assert.equal(weakPin('407193'), '');
  assert.equal(weakPin('58204716'), '');
});

test('قبل التعيين: الأجهزة ترى أنه غير معيّن', async () => {
  const r = await call('GET', '/api/pos-devices/pin', tok.cashier);
  assert.equal(r.status, 200); assert.equal(r.body.pin.set, false);
});

test('مدير النظام وحده يعيّن الرمز، والأجهزة تقرأ البصمة لا الرمز', async () => {
  for (const role of ['manager', 'cashier', 'waiter']) assert.equal((await call('PUT', '/api/pos-devices/pin', tok[role], { pin: '407193' })).status, 403, role);
  assert.equal((await call('PUT', '/api/pos-devices/pin', tok.admin, { pin: '123456' })).status, 400);
  const s = await call('PUT', '/api/pos-devices/pin', tok.admin, { pin: '407193' });
  assert.equal(s.status, 200); assert.equal(s.body.pin.version, 1); assert.equal(s.body.pin.hash, undefined, 'رد التعيين بلا بصمة');
  const g = await call('GET', '/api/pos-devices/pin', tok.cashier);
  assert.equal(g.body.pin.set, true); assert.equal(g.body.pin.alg, 'pbkdf2-sha256');
  assert.ok(!JSON.stringify(g.body).includes('407193'), 'الرمز لا يُرسل');
  // التحقق كما يفعله DiyarPOS (Rfc2898DeriveBytes.Pbkdf2 SHA256، 32 بايت)
  const p = g.body.pin;
  const calc = (pin) => crypto.pbkdf2Sync(pin, Buffer.from(p.salt, 'base64'), p.iter, 32, 'sha256').toString('base64');
  assert.equal(calc('407193'), p.hash);
  assert.notEqual(calc('407194'), p.hash);
  assert.ok(p.iter >= 100000);
  assert.equal((await call('GET', '/api/pos-devices/pin', tok.waiter)).status, 403, 'النادل ليس جهاز بيع');
  assert.equal((await call('GET', '/api/pos-devices/pin', tok.center)).status, 403, 'موظف السنتر من المنزل');
});

test('إعادة التعيين تبطل القديم وترفع الإصدار', async () => {
  const s = await call('PUT', '/api/pos-devices/pin', tok.admin, { pin: '58204716' });
  assert.equal(s.body.pin.version, 2);
  const p = (await call('GET', '/api/pos-devices/pin', tok.manager)).body.pin;
  const calc = (pin) => crypto.pbkdf2Sync(pin, Buffer.from(p.salt, 'base64'), p.iter, 32, 'sha256').toString('base64');
  assert.equal(calc('58204716'), p.hash);
  assert.notEqual(calc('407193'), p.hash);
});
