/*
  سحابة الصور: الرفع والفحص والرجوع لـ Cloudinary والنقل والإعدادات.
  • النماذج في الذاكرة (بلا MongoDB).
  • اختبارات «حقيقية» ضد ImageStorage يعمل محلياً إن وُجد:
      IMAGE_STORAGE_TEST_URL=http://127.0.0.1:5080 IMAGE_STORAGE_TEST_KEY=isk_...
    بدونهما تُتخطّى تلك الاختبارات فقط.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.IMAGE_CLOUD_ALLOW_PRIVATE = '1'; // خدمة الاختبار على 127.0.0.1
const IS_URL = process.env.IMAGE_STORAGE_TEST_URL || '';
const IS_KEY = process.env.IMAGE_STORAGE_TEST_KEY || '';
const LIVE = !!(IS_URL && IS_KEY);
const PHOTO = process.env.IMAGE_STORAGE_TEST_PHOTO || path.join(__dirname, 'fixtures', 'photo.jpg');

// ── ImageCloud في الذاكرة ──
const ImageCloud = require('../models/ImageCloud');
let DOC = null;
const q = (val) => ({ select() { return this; }, lean: async () => (val ? JSON.parse(JSON.stringify(val)) : null) });
ImageCloud.findOne = () => q(DOC);
ImageCloud.updateOne = async (f, u) => {
  DOC = DOC || { key: 'main' };
  Object.entries(u.$set || {}).forEach(([k, v]) => {
    const parts = k.split('.'); let o = DOC;
    while (parts.length > 1) { const p = parts.shift(); o[p] = o[p] || {}; o = o[p]; }
    o[parts[0]] = v;
  });
  Object.entries(u.$inc || {}).forEach(([k, v]) => { DOC[k] = (DOC[k] || 0) + v; });
  Object.entries(u.$pull || {}).forEach(([k, cond]) => {
    DOC[k] = (DOC[k] || []).filter((x) => !Object.entries(cond).every(([ck, cv]) => x[ck] === cv));
  });
  return { modifiedCount: 1 };
};

const imageCloud = require('../services/imageCloudService');
const migration = require('../services/imageMigrationService');
const reset = (d) => { DOC = d ? { key: 'main', ...d } : null; imageCloud.invalidate(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const photo = () => fs.readFileSync(PHOTO);

test('صلاحية images:cloud لمدير النظام وحده افتراضياً، وتُمنح لغيره', () => {
  const { effectivePermissionsFor } = require('../utils/permissions');
  assert.ok(effectivePermissionsFor({ role: 'admin' }).includes('images:cloud'));
  assert.ok(!effectivePermissionsFor({ role: 'manager', permissions: [] }).includes('images:cloud'));
  assert.ok(!effectivePermissionsFor({ role: 'cashier', permissions: [] }).includes('images:cloud'));
  assert.ok(effectivePermissionsFor({ role: 'manager', permissions: ['images:cloud'] }).includes('images:cloud'));
});

test('سحابة غير مفعّلة ← لا إعدادات فعّالة (يبقى Cloudinary)', async () => {
  reset({ enabled: false, baseUrl: 'http://x', apiKey: 'isk_abcdefghijk' });
  assert.equal(await imageCloud.activeConfig(), null);
  reset({ enabled: true, baseUrl: '', apiKey: 'isk_abcdefghijk' });
  assert.equal(await imageCloud.activeConfig(), null);
});

test('جهاز الصور مطفأ: الفحص يشرح بالعربية', async () => {
  const t = await imageCloud.test({ baseUrl: 'http://127.0.0.1:1', apiKey: 'isk_abcdefghijk' });
  assert.equal(t.ok, false);
  assert.match(t.message, /لا يرد/);
});

test('الرفع الحقيقي إلى ImageStorage: رابط medium عام يعمل', { skip: !LIVE }, async () => {
  reset({ enabled: true, baseUrl: IS_URL, apiKey: IS_KEY, projectId: 'diyar' });
  const r = await imageCloud.upload(photo(), { filename: 'burger.jpg', mime: 'image/jpeg', folder: 'products', variant: 'medium' });
  assert.match(r.id, /^[0-9A-Z]{26}$/);
  assert.equal(r.url, `${IS_URL}/media/${r.id}/medium`);
  let res;
  for (let i = 0; i < 20; i++) { res = await fetch(r.url); if (res.status !== 503) break; await wait(150); }
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\//);
});

test('فحص الاتصال: المفتاح الصحيح «متصل»، والخاطئ «مرفوض»', { skip: !LIVE }, async () => {
  const ok = await imageCloud.test({ baseUrl: IS_URL, apiKey: IS_KEY });
  assert.equal(ok.ok, true);
  assert.ok(ok.node);
  const bad = await imageCloud.test({ baseUrl: IS_URL, apiKey: 'isk_wrongwrongwrong_xx' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /مرفوض/);
});

test('ملف ليس صورة: ImageStorage يرفضه برسالة عربية (لا يرجع لـ Cloudinary)', { skip: !LIVE }, async () => {
  reset({ enabled: true, baseUrl: IS_URL, apiKey: IS_KEY });
  await assert.rejects(imageCloud.upload(Buffer.from('hello not an image'), { filename: 'x.jpg', mime: 'image/jpeg' }), (e) => [415, 422, 400].includes(e.status));
});

/* ── multer: الرفع عبر سحابة الصور، والرجوع لـ Cloudinary ── */
function serve(storage, baseUrl = '/api/products') {
  const express = require('express');
  const multer = require('multer');
  const app = express();
  const up = multer({ storage });
  app.post(`${baseUrl}`, up.single('image'), (req, res) => res.json({ file: req.file }));
  app.use(require('../middlewares/errorHandler').errorHandler); // معالج الخادم الحقيقي: الرسالة والرمز كما يراهما المستخدم
  return new Promise((r) => { const s = app.listen(0, () => r(s)); });
}
async function post(server, baseUrl = '/api/products', buf = photo()) {
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/jpeg' }), 'p.jpg');
  const res = await fetch(`http://127.0.0.1:${server.address().port}${baseUrl}`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}
const fakeFallback = { _handleFile(req, file, cb) { file.stream.resume(); file.stream.on('end', () => cb(null, { path: 'https://res.cloudinary.com/demo/image/upload/fallback.jpg', storage: 'cloudinary-stream' })); }, _removeFile(r, f, cb) { cb(null); } };

test('غير مفعّلة ← Cloudinary كما كان تماماً', async () => {
  reset({ enabled: false });
  const { HybridStorage } = require('../middlewares/upload');
  const s = await serve(new HybridStorage(fakeFallback));
  const r = await post(s);
  s.close();
  assert.equal(r.body.file.path, 'https://res.cloudinary.com/demo/image/upload/fallback.jpg');
});

test('مفعّلة ← الصنف يُحفظ برابط سحابة الصور (medium)، والإعدادات (large)', { skip: !LIVE }, async () => {
  reset({ enabled: true, baseUrl: IS_URL, apiKey: IS_KEY });
  const { HybridStorage } = require('../middlewares/upload');
  const s1 = await serve(new HybridStorage(fakeFallback), '/api/products');
  const r1 = await post(s1, '/api/products');
  s1.close();
  assert.match(r1.body.file.path, new RegExp(`^${IS_URL}/media/[0-9A-Z]{26}/medium$`));
  const s2 = await serve(new HybridStorage(fakeFallback), '/api/settings/logo');
  const r2 = await post(s2, '/api/settings/logo');
  s2.close();
  assert.match(r2.body.file.path, /\/large$/);
  await wait(50);
  assert.ok(DOC.uploads >= 2);
});

test('السحابة المحلية مختارة والجهاز لا يرد ← لا Cloudinary: الصورة تُرفض برسالة واضحة', async () => {
  reset({ enabled: true, baseUrl: 'http://127.0.0.1:1', apiKey: 'isk_abcdefghijk' });
  const cloudinary = require('../config/cloudinary');
  const orig = cloudinary.uploader.upload_stream;
  let calls = 0;
  cloudinary.uploader.upload_stream = (opts, cb) => ({ end() { calls++; cb(null, { secure_url: 'x', public_id: 'x' }); } });
  const { HybridStorage } = require('../middlewares/upload');
  const prevEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; // كما في Railway: الرسالة تصل لا «خطأ في الخادم»
  const s = await serve(new HybridStorage(fakeFallback));
  const r = await post(s);
  s.close(); process.env.NODE_ENV = prevEnv;
  cloudinary.uploader.upload_stream = orig;
  assert.equal(r.status, 503);
  assert.match(r.body.message, /لم تُرفع الصورة — سحابة الصور: .*لا يرد.*شغّل DiyarPOS/);
  assert.equal(calls, 0, 'لا شيء إلى Cloudinary');
  await wait(50);
  assert.ok(!DOC.fallbacks, 'لا «رجوع» محسوب');
  assert.match(DOC.lastError, /لا يرد/);

  // بانتظار التفعيل (لم يرد الجهاز بعد) ← نفس الرفض بالسبب، لا Cloudinary
  reset({ enabled: false, wantEnabled: true, lastError: 'لا يوجد جهاز صور متصل بالخادم', baseUrl: 'http://127.0.0.1:1' });
  const s2 = await serve(new HybridStorage(fakeFallback));
  const r2 = await post(s2); s2.close();
  assert.equal(r2.status, 503);
  assert.match(r2.body.message, /لم تُفعَّل بعد — لا يوجد جهاز صور متصل/);
});

test('الرجوع لـ Cloudinary مسموح صراحة ← نفس الصورة تُرفع لـ Cloudinary ويُسجَّل السبب', async () => {
  reset({ enabled: true, baseUrl: 'http://127.0.0.1:1', apiKey: 'isk_abcdefghijk', cloudinaryFallback: true });
  const cloudinary = require('../config/cloudinary');
  const orig = cloudinary.uploader.upload_stream;
  let got = 0;
  cloudinary.uploader.upload_stream = (opts, cb) => ({ end(buf) { got = buf.length; cb(null, { secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/diyar/x.jpg', public_id: 'diyar/x' }); } });
  const { HybridStorage } = require('../middlewares/upload');
  const s = await serve(new HybridStorage(fakeFallback));
  const r = await post(s);
  s.close();
  cloudinary.uploader.upload_stream = orig;
  assert.equal(r.status, 200);
  assert.equal(r.body.file.path, 'https://res.cloudinary.com/demo/image/upload/v1/diyar/x.jpg');
  assert.equal(got, photo().length);
  await wait(50);
  assert.equal(DOC.fallbacks, 1);
  assert.match(DOC.lastError, /لا يرد/);
});

test('لم تُختر السحابة المحلية أصلاً ← Cloudinary كما كان', async () => {
  reset(null);
  const { HybridStorage } = require('../middlewares/upload');
  const s = await serve(new HybridStorage(fakeFallback));
  const r = await post(s); s.close();
  assert.equal(r.status, 200);
  assert.match(r.body.file.path, /cloudinary/);
});

/* ── النقل من Cloudinary ── */
test('جمع روابط Cloudinary من أي حقل (والفيديو والروابط الأخرى لا تُلمس)', () => {
  const refs = migration.collect({
    _id: 'x', logo: 'https://res.cloudinary.com/d/image/upload/v1/a.jpg',
    heroBackgroundUrl: 'https://res.cloudinary.com/d/video/upload/v1/h.mp4',
    gallery: [{ url: 'https://res.cloudinary.com/d/image/upload/v1/g.png' }, { url: 'https://other.com/x.jpg' }],
    when: new Date(),
  });
  assert.deepEqual(refs.map((r) => r.path), ['logo', 'gallery.0.url']);
});

test('نقل كل الصور: تُرفع وتُستبدل الروابط، والإعادة لا تنقل شيئاً', { skip: !LIVE }, async () => {
  reset({ enabled: true, baseUrl: IS_URL, apiKey: IS_KEY });
  // مجموعات في الذاكرة
  const mk = (docs) => ({
    docs,
    find: () => ({ toArray: async () => JSON.parse(JSON.stringify(docs)) }),
    updateOne: async (f, u) => {
      const d = docs.find((x) => x._id === f._id);
      const [p, val] = Object.entries(u.$set)[0];
      const get = (o, k) => k.split('.').reduce((a, b) => (a == null ? a : a[b]), o);
      if (!d || get(d, p) !== f[p]) return { modifiedCount: 0 };
      const parts = p.split('.'); let o = d; while (parts.length > 1) o = o[parts.shift()]; o[parts[0]] = val;
      return { modifiedCount: 1 };
    },
  });
  const C = 'https://res.cloudinary.com/demo/image/upload/v1/diyar-alanbat/';
  const P = mk([{ _id: 'p1', image: `${C}a.jpg`, images: [`${C}a.jpg`, `${C}b.jpg`] }, { _id: 'p2', image: 'https://cdn.other/x.jpg' }]);
  const K = mk([{ _id: 'c1', image: `${C}c.jpg` }]);
  const S = mk([{ _id: 's1', logo: `${C}logo.png`, heroBackgroundUrl: 'https://res.cloudinary.com/demo/video/upload/v1/h.mp4', gallery: [{ url: `${C}g1.jpg` }] }]);
  const N = mk([]);
  require('../models/Product').collection = P;
  require('../models/Category').collection = K;
  require('../models/Setting').collection = S;
  require('../models/Notification').collection = N;
  // Cloudinary وهمي: يعيد نفس صورة الاختبار لكل رابط
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).startsWith('https://res.cloudinary.com/')
    ? Promise.resolve(new Response(photo(), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    : realFetch(url, opts));
  try {
    const r = await migration.run('مروان');
    assert.equal(r.total, 5, 'a.jpg (مرة واحدة رغم تكراره) + b + c + logo + g1');
    assert.equal(r.done, 5);
    assert.equal(r.failed, 0);
    const cloud = new RegExp(`^${IS_URL}/media/[0-9A-Z]{26}/`);
    assert.match(P.docs[0].image, cloud);
    assert.match(P.docs[0].image, /\/medium$/);
    assert.equal(P.docs[0].images[0], P.docs[0].image, 'نفس الصورة ← نفس الرابط الجديد');
    assert.match(P.docs[0].images[1], cloud);
    assert.equal(P.docs[1].image, 'https://cdn.other/x.jpg');
    assert.match(K.docs[0].image, /\/medium$/);
    assert.match(S.docs[0].logo, /\/large$/);
    assert.match(S.docs[0].gallery[0].url, /\/large$/);
    assert.equal(S.docs[0].heroBackgroundUrl, 'https://res.cloudinary.com/demo/video/upload/v1/h.mp4', 'الفيديو يبقى');
    assert.equal(DOC.migration.status, 'done');
    assert.equal(DOC.migration.updatedDocs, 3);
    const again = await migration.run('مروان');
    assert.equal(again.total, 0);
  } finally { globalThis.fetch = realFetch; }
});

/* ── الإعدادات (المتحكم) ── */
const ADMIN = { name: 'مروان', role: 'admin' };
const CASHIER = { name: 'سامي', role: 'cashier', permissions: [] };
function call(fn, body = {}, query = {}, user = ADMIN, params = {}) {
  const c = require('../controllers/imageCloudController');
  return new Promise((resolve) => {
    const res = { code: 200, status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    c[fn]({ user, body, query, params }, res, (e) => resolve({ code: 500, body: { message: e && e.message } }));
  });
}

test('الإعدادات: التفعيل يُختبر أولاً، والمفتاح لا يُعاد أبداً', async () => {
  reset(null);
  let r = await call('update', { enabled: true, baseUrl: 'ftp://x', apiKey: 'isk_abcdefghijklmn' });
  assert.equal(r.code, 400);
  r = await call('update', { enabled: true, baseUrl: 'http://127.0.0.1:1', apiKey: 'isk_abcdefghijklmn' });
  assert.equal(r.code, 400);
  assert.match(r.body.message, /لا يرد/);
  r = await call('update', { enabled: true, baseUrl: 'http://127.0.0.1:1', apiKey: 'bad' });
  assert.equal(r.code, 400);
  assert.match(r.body.message, /isk_/);
  if (!LIVE) return;
  r = await call('update', { enabled: true, baseUrl: `${IS_URL}/`, apiKey: IS_KEY, projectId: 'diyar', linkedFrom: 'DiyarPOS — الكاشير' });
  assert.equal(r.code, 200);
  assert.equal(r.body.cloud.enabled, true);
  assert.equal(r.body.cloud.baseUrl, IS_URL, 'الشرطة الأخيرة تُحذف');
  assert.equal(r.body.cloud.hasKey, true);
  assert.equal(r.body.cloud.keyHint, `…${IS_KEY.slice(-4)}`);
  assert.equal(JSON.stringify(r.body).includes(IS_KEY), false, 'المفتاح لا يظهر في أي رد');
  // تعديل بلا مفتاح يُبقي المفتاح المحفوظ
  r = await call('update', { projectId: 'diyar2' });
  assert.equal(r.body.cloud.hasKey, true);
  r = await call('update', { enabled: false });
  assert.equal(r.body.cloud.enabled, false);
});

/* ── أجهزة المزامنة: الانضمام، النبض، الإشعار بالملفات الناقصة والجهاز المنقطع ── */
test('الانضمام: أول جهاز يحدد الأسرار، والثاني يأخذها مع قائمة الأجهزة', async () => {
  reset({ enabled: true, baseUrl: 'https://img.example.com', apiKey: 'isk_abcdefghijk', projectId: 'diyar', nodes: [] });
  const nodes = require('../services/imageCloudNodes');
  await assert.rejects(nodes.join({ name: 'مروان' }, { nodeId: 'bad id!' }), /غير صالح/);
  const a = await nodes.join({ name: 'مروان' }, { nodeId: 'pos-a', name: 'CASHIER', lanUrl: 'http://192.168.1.20:7443/', signingSecret: 'S'.repeat(40), tunnelToken: 'TUN' });
  assert.ok(a.syncSecret.length >= 32);
  assert.equal(a.signingSecret, 'S'.repeat(40), 'سرّ التوقيع من أول جهاز');
  assert.deepEqual(a.peers, []);
  const b = await nodes.join({ name: 'مروان' }, { nodeId: 'pos-b', name: 'OFFICE', lanUrl: 'http://192.168.1.30:7443', signingSecret: 'X'.repeat(40) });
  assert.equal(b.syncSecret, a.syncSecret, 'نفس سرّ المزامنة');
  assert.equal(b.signingSecret, a.signingSecret, 'نفس سرّ التوقيع (لا يتغير بانضمام جهاز ثانٍ)');
  assert.equal(b.tunnelToken, 'TUN', 'رمز النفق يصل للجهاز الثاني تلقائياً');
  assert.equal(b.publicUrl, 'https://img.example.com');
  assert.deepEqual(b.peers, [{ nodeId: 'pos-a', url: 'http://192.168.1.20:7443' }]);
  // إعادة الانضمام لا تكرر الجهاز
  await nodes.join({ name: 'مروان' }, { nodeId: 'pos-a', name: 'CASHIER', lanUrl: 'http://192.168.1.21:7443' });
  assert.equal(DOC.nodes.length, 2);
  assert.equal(DOC.nodes.find((n) => n.nodeId === 'pos-a').lanUrl, 'http://192.168.1.21:7443', 'العنوان الجديد يُحدَّث');
});

test('النبض: قائمة الأجهزة المحدّثة، وجهاز غير منضم يُرفض', async () => {
  const nodes = require('../services/imageCloudNodes');
  await assert.rejects(nodes.heartbeat({ nodeId: 'pos-zzz' }), (e) => e.status === 404);
  const r = await nodes.heartbeat({ nodeId: 'pos-a', running: true, local: { images: 10, missingFiles: 0, peers: [{ nodeId: 'pos-b', connected: true }] } });
  assert.deepEqual(r.peers, [{ nodeId: 'pos-b', url: 'http://192.168.1.30:7443' }]);
  assert.equal(r.issue, '');
});

test('ملفات ناقصة تستمر ← إشعار واحد لمدير النظام، ثم «سليمة» عند اكتمالها', async () => {
  const nodes = require('../services/imageCloudNodes');
  const sent = [];
  const notify = (type, p) => sent.push({ type, ...p });
  const hb = (id, local) => nodes.heartbeat({ nodeId: id, running: true, local }, notify);
  await hb('pos-a', { images: 10, missingFiles: 0, peers: [{ nodeId: 'pos-b', connected: true }] });
  await hb('pos-b', { images: 10, missingFiles: 4, peers: [{ nodeId: 'pos-a', connected: true }] });
  assert.equal(sent.length, 0, 'ملفات تُجلب الآن — لا إنذار فوراً');
  // بعد مهلة السماح (الافتراضي دقيقتان): نُرجع بداية النقص للوراء
  DOC.nodes.find((n) => n.nodeId === 'pos-b').missingSince = new Date(Date.now() - 5 * 60000).toISOString();
  await hb('pos-b', { images: 10, missingFiles: 4, peers: [{ nodeId: 'pos-a', connected: true }] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'imagecloud.alert');
  assert.match(sent[0].message, /OFFICE ينقصه 4 ملف/);
  await hb('pos-b', { images: 10, missingFiles: 4, peers: [{ nodeId: 'pos-a', connected: true }] });
  assert.equal(sent.length, 1, 'لا تكرار كل دقيقة');
  await hb('pos-b', { images: 10, missingFiles: 0, peers: [{ nodeId: 'pos-a', connected: true }] });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].level, 'ok');
});

test('جهاز لا يتصل بآخر، وجهاز اختفى ← إشعار من نبض الجهاز الآخر', async () => {
  const nodes = require('../services/imageCloudNodes');
  const sent = [];
  const notify = (type, p) => sent.push({ type, ...p });
  await nodes.heartbeat({ nodeId: 'pos-a', running: true, local: { images: 10, missingFiles: 0, peers: [{ nodeId: 'pos-b', connected: false }] } }, notify);
  assert.match(sent.pop().message, /CASHIER لا يتصل بـ OFFICE.*7443/);
  // OFFICE لم يرسل نبضاً منذ 10 دقائق
  DOC.nodes.find((n) => n.nodeId === 'pos-b').lastSeen = new Date(Date.now() - 10 * 60000).toISOString();
  await nodes.heartbeat({ nodeId: 'pos-a', running: true, local: { images: 10, missingFiles: 0, peers: [{ nodeId: 'pos-b', connected: false }] } }, notify);
  assert.ok(sent.some((m) => /OFFICE لا يرسل حالته منذ 10 دقيقة/.test(m.message)), sent.map((m) => m.message).join(' | '));
  const v = nodes.view(DOC.nodes);
  assert.equal(v.find((n) => n.nodeId === 'pos-b').online, false);
});

test('الأسرار لا تظهر في عرض الإعدادات', async () => {
  const r = await call('get');
  const txt = JSON.stringify(r.body);
  assert.equal(r.body.cloud.nodes.length, 2);
  assert.ok(!txt.includes(DOC.syncSecret) && !txt.includes('TUN') && !txt.includes('S'.repeat(40)));
});

/* ── الربط التلقائي: DiyarPOS يطلب ← المدير يوافق من الهاتف ← الجهاز يستلم (بلا نسخ مفتاح) ── */
const crypto = require('crypto');
const proofOf = (s) => crypto.createHash('sha256').update(s).digest('hex');
const realtime = require('../services/realtimeService');

test('طلب ربط من حساب كاشير: ينتظر الموافقة، وإشعار واحد لمدير النظام', async () => {
  reset({ enabled: false, nodes: [], requests: [] });
  const sent = []; const orig = realtime.broadcast; realtime.broadcast = (t, p) => sent.push({ t, ...p });
  try {
    let r = await call('nodeRequest', { nodeId: 'pos-cash-1a2b', name: 'CASHIER', proofHash: proofOf('SECRET-1'), lanUrl: 'http://192.168.1.20:7443' }, {}, CASHIER);
    assert.equal(r.code, 200);
    assert.equal(r.body.status, 'pending');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, 'imagecloud.request');
    assert.match(sent[0].message, /CASHIER يطلب ربط سحابة الصور/);
    r = await call('nodeRequest', { nodeId: 'pos-cash-1a2b', name: 'CASHIER', proofHash: proofOf('SECRET-1') }, {}, CASHIER);
    assert.equal(r.body.status, 'pending');
    assert.equal(sent.length, 1, 'الاستطلاع المتكرر لا يكرر الإشعار');
    r = await call('nodeRequest', { nodeId: 'pos-cash-1a2b', proofHash: 'zz' }, {}, CASHIER);
    assert.equal(r.code, 400);
    // الطلب يظهر في اللوحة
    r = await call('get');
    assert.equal(r.body.cloud.requests.length, 1);
    assert.equal(r.body.cloud.requests[0].name, 'CASHIER');
    assert.equal(r.body.cloud.requests[0].requestedBy, 'سامي');
    assert.ok(!JSON.stringify(r.body).includes(proofOf('SECRET-1')), 'البصمة لا تُعرض');
  } finally { realtime.broadcast = orig; }
});

test('قبل الموافقة لا أسرار، وبسرّ خاطئ لا أسرار — حتى بعد الموافقة', async () => {
  let r = await call('nodeClaim', { nodeId: 'pos-cash-1a2b', proof: 'SECRET-1' }, {}, CASHIER);
  assert.equal(r.code, 409);
  assert.match(r.body.message, /بانتظار موافقة/);
  r = await call('nodeDecide', { approve: true }, {}, ADMIN, { nodeId: 'pos-cash-1a2b' });
  assert.equal(r.code, 200);
  assert.equal(r.body.cloud.requests.length, 0, 'المُوافَق عليه يختفي من قائمة الانتظار');
  r = await call('nodeRequest', { nodeId: 'pos-cash-1a2b', proofHash: proofOf('SECRET-1') }, {}, CASHIER);
  assert.equal(r.body.status, 'approved');
  assert.equal(r.body.approvedBy, 'مروان');
  r = await call('nodeClaim', { nodeId: 'pos-cash-1a2b', proof: 'WRONG' }, {}, CASHIER);
  assert.equal(r.code, 403);
  assert.ok(!r.body.syncSecret);
});

test('الاستلام: ينضم للمزامنة ويحفظ المفتاح؛ بلا رابط عام لا يُفعَّل ويشرح السبب', async () => {
  const sent = []; const orig = realtime.broadcast; realtime.broadcast = (t, p) => sent.push({ t, ...p });
  try {
    const r = await call('nodeClaim', {
      nodeId: 'pos-cash-1a2b', proof: 'SECRET-1', name: 'CASHIER', lanUrl: 'http://192.168.1.20:7443',
      apiKey: 'isk_abcdefghijklmnop', projectId: 'diyar', signingSecret: 'S'.repeat(40),
    }, {}, CASHIER);
    assert.equal(r.code, 200);
    assert.ok(r.body.syncSecret.length >= 32);
    assert.equal(r.body.signingSecret, 'S'.repeat(40));
    assert.equal(r.body.link.enabled, false);
    assert.match(r.body.link.message, /الرابط العام/);
    assert.equal(DOC.apiKey, 'isk_abcdefghijklmnop', 'المفتاح حُفظ تلقائياً');
    assert.equal(DOC.enabled, false);
    assert.equal(DOC.requests.length, 0, 'الطلب حُذف بعد الاستلام');
    assert.ok(DOC.nodes[0].proofHash === proofOf('SECRET-1'));
    assert.ok(sent.some((m) => m.t === 'imagecloud.alert' && /CASHIER/.test(m.message)));
    // الطلب التالي من نفس الجهاز: «منضم»
    const again = await call('nodeRequest', { nodeId: 'pos-cash-1a2b', proofHash: proofOf('SECRET-1') }, {}, CASHIER);
    assert.equal(again.body.status, 'joined');
  } finally { realtime.broadcast = orig; }
});

test('رمز النفق والرابط العام من الهاتف ← يصلان للجهاز في نبضه (لمن يثبت هويته فقط)', async () => {
  let r = await call('update', { tunnelToken: 'eyJ-TUNNEL-TOKEN', baseUrl: 'https://img.example.com' });
  assert.equal(r.body.cloud.hasTunnel, true);
  assert.ok(!JSON.stringify(r.body).includes('eyJ-TUNNEL-TOKEN'), 'الرمز لا يُعاد للوحة');
  const nodes = require('../services/imageCloudNodes');
  let hb = await nodes.heartbeat({ nodeId: 'pos-cash-1a2b', running: true });
  assert.equal(hb.config, undefined, 'بلا سر الجهاز: لا رمز');
  hb = await nodes.heartbeat({ nodeId: 'pos-cash-1a2b', running: true, proof: 'WRONG' });
  assert.equal(hb.config, undefined);
  hb = await nodes.heartbeat({ nodeId: 'pos-cash-1a2b', running: true, proof: 'SECRET-1' });
  assert.deepEqual(hb.config, { publicUrl: 'https://img.example.com', tunnelToken: 'eyJ-TUNNEL-TOKEN' });
});

test('مدير النظام على DiyarPOS ← موافقة فورية، والرفض يمنع الاستلام', async () => {
  let r = await call('nodeRequest', { nodeId: 'pos-office-9f8e', name: 'OFFICE', proofHash: proofOf('SECRET-2') }, {}, ADMIN);
  assert.equal(r.body.status, 'approved');
  r = await call('nodeRequest', { nodeId: 'pos-x-0001', name: 'X', proofHash: proofOf('SECRET-3') }, {}, CASHIER);
  assert.equal(r.body.status, 'pending');
  r = await call('nodeDecide', { approve: false }, {}, ADMIN, { nodeId: 'pos-x-0001' });
  assert.equal(r.body.cloud.requests.find((x) => x.nodeId === 'pos-x-0001').status, 'rejected');
  r = await call('nodeClaim', { nodeId: 'pos-x-0001', proof: 'SECRET-3' }, {}, CASHIER);
  assert.equal(r.code, 409);
  assert.match(r.body.message, /رفض/);
});

test('الاستلام مع رابط عام يعمل ← تُفعَّل السحابة تلقائياً', { skip: !LIVE }, async () => {
  reset({ enabled: false, nodes: [], requests: [] });
  await call('nodeRequest', { nodeId: 'pos-live-0001', name: 'LIVE', proofHash: proofOf('S-LIVE') }, {}, ADMIN);
  const r = await call('nodeClaim', { nodeId: 'pos-live-0001', proof: 'S-LIVE', apiKey: IS_KEY, publicUrl: `${IS_URL}/`, projectId: 'diyar' }, {}, CASHIER);
  assert.equal(r.code, 200);
  assert.equal(r.body.link.enabled, true, r.body.link.message);
  assert.equal(DOC.enabled, true);
  assert.equal(DOC.baseUrl, IS_URL);
});

test('أول جهاز: الرابط ورمز النفق من الهاتف ← تُفعَّل السحابة تلقائياً عند أول رد للجهاز', async () => {
  // خدمة صور وهمية «تستيقظ» لاحقاً (كأن النفق اتصل بعد وصول الرمز للجهاز)
  let up = false;
  const srv = http.createServer((req, res) => {
    if (!up) { res.writeHead(502); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/api/v1/health') ? '{"node":"pos-first"}' : '{"items":[]}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const sent = []; const orig = realtime.broadcast; realtime.broadcast = (t, p) => sent.push({ t, ...p });
  try {
    reset({ enabled: false, nodes: [], requests: [] });
    await call('nodeRequest', { nodeId: 'pos-first-0001', name: 'CASHIER', proofHash: proofOf('F1') }, {}, ADMIN);
    let r = await call('nodeClaim', { nodeId: 'pos-first-0001', proof: 'F1', apiKey: 'isk_firstdevicekey1', projectId: 'diyar' }, {}, CASHIER);
    assert.equal(r.body.link.enabled, false);
    assert.equal(DOC.wantEnabled, true, 'أول جهاز: يُراد تفعيلها');
    // المدير يضع الرابط ورمز النفق من الهاتف ويفعّل — الجهاز لم يستلم الرمز بعد
    r = await call('update', { enabled: true, baseUrl: url, tunnelToken: 'eyJ-T' });
    assert.equal(r.code, 200, r.body.message);
    assert.equal(r.body.pending, true);
    assert.match(r.body.message, /تلقائياً/);
    assert.equal(r.body.cloud.enabled, false);
    assert.equal(r.body.cloud.wantEnabled, true);
    // نبض الجهاز: ما زال لا يرد ← لا تفعيل
    await call('nodeHeartbeat', { nodeId: 'pos-first-0001', running: true, proof: 'F1' }, {}, CASHIER);
    await wait(100);
    assert.equal(DOC.enabled, false);
    // النفق اتصل؛ النبض التالي (بعد 20 ثانية على الأقل) ← تفعيل وإشعار
    up = true;
    DOC.lastAutoTry = new Date(Date.now() - 30000).toISOString();
    await call('nodeHeartbeat', { nodeId: 'pos-first-0001', running: true, proof: 'F1' }, {}, CASHIER);
    for (let i = 0; i < 40 && !DOC.enabled; i++) await wait(25);
    assert.equal(DOC.enabled, true, 'فُعّلت تلقائياً');
    assert.ok(sent.some((m) => /فُعّلت سحابة الصور تلقائياً/.test(m.message || '')));
    // المدير يوقفها صراحة ← لا تفعيل تلقائي بعدها
    await call('update', { enabled: false });
    DOC.lastAutoTry = null;
    await call('nodeHeartbeat', { nodeId: 'pos-first-0001', running: true }, {}, CASHIER);
    await wait(100);
    assert.equal(DOC.enabled, false);
  } finally { realtime.broadcast = orig; srv.close(); }
});
