/**
 * شاشة العميل (الشاشة الثانية للكاشير): الإعلانات والخيارات، ونوع بانر المينيو (صورة/فيديو).
 *   node --test tests/customerDisplay.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
require('../models/Setting'); // النموذج قبل تثبيت القاعدة في الذاكرة (تُستبدل دوال النماذج المسجّلة)
require('./helpers/memoryDb').installAll();

// الرفع الحقيقي (سحابة الصور) مختبر في tools/video-e2e.js — هنا الملف «رُفع» بالفعل
const fakeUpload = (field) => (req, res, next) => {
  const name = String(req.headers['x-test-file'] || '');
  if (name) req.file = { path: `https://api.test/api/image-cloud/relay/media/${name.replace(/\W/g, '')}/large`, originalname: name, mimetype: /\.(mp4|webm|mov)$/.test(name) ? 'video/mp4' : 'image/jpeg', fieldname: field };
  next();
};
const up = Object.assign((req, res, next) => next(), { single: fakeUpload, fields: () => (q, s, n) => n(), uploadMedia: { single: fakeUpload } });
require.cache[require.resolve('../middlewares/upload')] = { exports: up };
const users = { ADMIN: { _id: 'u1', name: 'مروان', role: 'admin', permissions: [] }, CASHIER: { _id: 'u2', name: 'سامي', role: 'cashier', permissions: [] } };
require.cache[require.resolve('../middlewares/auth')] = { exports: {
  protect: (req, res, next) => { const t = String(req.headers.authorization || '').replace('Bearer ', ''); if (!users[t]) return res.status(401).json({}); req.user = users[t]; next(); },
  authorize: (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'غير مصرح' })),
} };
require.cache[require.resolve('../middlewares/activityLogger')] = { exports: { audit: () => (req, res, next) => next() } };

let server; let base;
test.before(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/settings', require('../routes/settingRoutes'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const call = async (method, p, { token, file, body } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(file ? { 'X-Test-File': file } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('بانر المينيو: الفيديو يُحفظ بنوع video والصورة image', async () => {
  const v = await call('POST', '/api/settings/menu-banners', { token: 'ADMIN', file: 'offer.mp4' });
  assert.equal(v.status, 200); assert.equal(v.body.menuBanners.at(-1).type, 'video');
  const i = await call('POST', '/api/settings/menu-banners', { token: 'ADMIN', file: 'offer.jpg' });
  assert.equal(i.body.menuBanners.at(-1).type, 'image');
});

test('إعلانات شاشة العميل: الإضافة والترتيب والخيارات والحذف — للوحة فقط، والقراءة عامة', async () => {
  assert.equal((await call('POST', '/api/settings/customer-display/ads', { file: 'a.jpg' })).status, 401);
  assert.equal((await call('POST', '/api/settings/customer-display/ads', { token: 'CASHIER', file: 'a.jpg' })).status, 403);
  assert.equal((await call('POST', '/api/settings/customer-display/ads', { token: 'ADMIN' })).status, 400, 'بلا ملف');
  const a = await call('POST', '/api/settings/customer-display/ads', { token: 'ADMIN', file: 'promo.webm' });
  const b = await call('POST', '/api/settings/customer-display/ads', { token: 'ADMIN', file: 'meal.jpg' });
  assert.equal(a.body.display.ads[0].type, 'video'); assert.equal(b.body.display.ads.length, 2);
  const pub = await call('GET', '/api/settings/customer-display');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body.display.ads.map((x) => x.type), ['video', 'image']);
  assert.equal(pub.body.display.menuBanners.length, 2, 'بانرات المينيو تُعرض أيضاً افتراضياً');
  assert.equal(pub.body.display.showOrder, true); assert.equal(pub.body.display.imageSeconds, 8);
  const ids = pub.body.display.ads.map((x) => x._id);
  const o = await call('PUT', '/api/settings/customer-display', { token: 'ADMIN', body: { order: [ids[1], ids[0]], imageSeconds: 5, showOrder: false, includeMenuBanners: false, welcomeText: '  أهلاً  ' } });
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.display.ads.map((x) => x._id), [ids[1], ids[0]]);
  assert.equal(o.body.display.imageSeconds, 5); assert.equal(o.body.display.showOrder, false);
  assert.equal(o.body.display.menuBanners.length, 0); assert.equal(o.body.display.welcomeText, 'أهلاً');
  assert.equal((await call('PUT', '/api/settings/customer-display', { token: 'ADMIN', body: { imageSeconds: 1 } })).status, 400, 'مدة غير منطقية');
  assert.equal((await call('PUT', '/api/settings/customer-display', { token: 'CASHIER', body: { imageSeconds: 9 } })).status, 403);
  const d = await call('DELETE', `/api/settings/customer-display/ads/${ids[0]}`, { token: 'ADMIN' });
  assert.equal(d.body.display.ads.length, 1);
  assert.equal((await call('DELETE', `/api/settings/customer-display/ads/${ids[0]}`, { token: 'ADMIN' })).status, 404);
});
