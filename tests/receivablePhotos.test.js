/**
 * صور فواتير المورّدين: رفع الأصل، ربط الصور ونسخ الطباعة بالفاتورة، التحقق، الصلاحيات،
 * وأن نسخ الطباعة لا تُرسل في القوائم بل مع الفاتورة الواحدة والتسديد.
 *   node --test tests/receivablePhotos.test.js
 */
process.env.JWT_SECRET = 'recv-photos-secret-0123456789abcdef';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Receivable', 'ExpenseSequence', 'CapitalEntry', 'ActivityLog', 'ImageCloud', 'ShiftSession'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

// Cloudinary موقوف افتراضياً؛ هنا يُشغَّل وضع الطوارئ ليُختبر مسار الفاتورة بلا جهاز صور (Cloudinary وهمي)
process.env.CLOUDINARY_UPLOADS = 'on';
const cloudinary = require('../config/cloudinary');
let uploaded = 0;
cloudinary.uploader.upload_stream = (opts, cb) => {
  // تيار كتابة حقيقي (multer-storage-cloudinary يمرّر الملف بـ pipe)
  const chunks = []; const w = new (require('stream').Writable)({ write(c, e, next) { chunks.push(c); next(); } });
  w.on('finish', () => { uploaded = Buffer.concat(chunks).length; cb(null, { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${opts.folder || 'diyar-alanbat'}/receivables-inv-${Date.now()}.jpg`, public_id: 'inv' }); });
  return w;
};

let server; let base; const tokens = {};
const call = async (method, url, { token, body, form } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};
// صورة طباعة صغيرة حقيقية (PNG 1×1) كما تولّدها اللوحة
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/receivables', require('../routes/receivableRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, role] of [['admin', 'admin'], ['cashier', 'cashier'], ['employee', 'employee']]) {
    const u = await M('User').create({ name: k === 'admin' ? 'مروان' : k, username: k, password: 'secret123', role, isActive: true });
    tokens[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  }
});
test.after(() => server.close());

let photo;
test('رفع صورة الفاتورة الأصلية: للمخوّلين فقط، وتُعاد بياناتها', async () => {
  const form = () => { const f = new FormData(); f.append('image', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'invoice.jpg'); return f; };
  const denied = await call('POST', '/api/receivables/photo', { token: tokens.employee, form: form() });
  assert.equal(denied.status, 403, 'موظف بلا receivables:manage');
  const r = await call('POST', '/api/receivables/photo', { token: tokens.cashier, form: form() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.photo.url, /^https:\/\/res\.cloudinary\.com\//, 'رابط الصورة المرفوعة');
  assert.equal(uploaded, jpegBytes().length);
  photo = { ...r.body.photo, width: 1200, height: 1600 };
});

test('Cloudinary موقوف وسحابة الصور غير مفعّلة ← صورة الفاتورة تُرفض بسبب واضح (لا تضيع بصمت)', async () => {
  delete process.env.CLOUDINARY_UPLOADS;
  const before = uploaded; uploaded = -1;
  try {
    const f = new FormData(); f.append('image', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'invoice.jpg');
    const r = await call('POST', '/api/receivables/photo', { token: tokens.cashier, form: f });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.message, /سحابة الصور: غير مفعّلة/);
    assert.equal(uploaded, -1, 'لا شيء إلى Cloudinary');
  } finally { process.env.CLOUDINARY_UPLOADS = 'on'; uploaded = before; }
});

let id;
test('فاتورة بالمبلغ والصور فقط (بلا أسطر): نسخة الطباعة تعود مع الإنشاء، ولا تُرسل في القائمة', async () => {
  const r = await call('POST', '/api/receivables', { token: tokens.cashier, body: { customerName: 'محل الأمانة', invoiceNumber: 'A-77', amount: 12.5, photos: [photo], printImages: [PNG] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  id = r.body.receivable._id;
  assert.equal(r.body.receivable.amount, 12.5);
  assert.equal(r.body.receivable.status, 'unpaid');
  assert.equal(r.body.receivable.photos[0].url, photo.url);
  assert.equal(r.body.receivable.photos[0].addedByName, 'cashier');
  assert.deepEqual(r.body.receivable.printImages, [PNG]);
  const list = await call('GET', '/api/receivables?status=unpaid', { token: tokens.cashier });
  const row = list.body.data.find((x) => x._id === id);
  assert.equal(row.photos.length, 1, 'الصور في القائمة (روابط صغيرة)');
  assert.equal(row.printImages, undefined, 'نسخ الطباعة لا تُرسل في القوائم');
  const one = await call('GET', `/api/receivables/${id}`, { token: tokens.cashier });
  assert.deepEqual(one.body.receivable.printImages, [PNG], 'تُرسل مع الفاتورة الواحدة (للطباعة)');
});

test('التحقق: لا روابط عشوائية، ولا «صورة طباعة» ليست صورة، ولا أكثر من 4، ولا حجم كبير', async () => {
  const bad = async (extra, re) => {
    const r = await call('POST', '/api/receivables', { token: tokens.cashier, body: { customerName: 'م', amount: 1, ...extra } });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.message, re);
  };
  await bad({ photos: [{ url: 'javascript:alert(1)' }] }, /رابط صورة غير صالح/);
  await bad({ printImages: ['<svg onload=alert(1)>'] }, /يجب أن تكون صورة/);
  await bad({ printImages: [`data:image/png;base64,${'A'.repeat(700 * 1024)}`] }, /كبيرة جداً/);
  await bad({ photos: Array(5).fill(photo) }, /حتى 4 صور/);
});

test('إضافة صفحات لفاتورة موجودة: تُلحق، والحد 4', async () => {
  const r = await call('POST', `/api/receivables/${id}/photos`, { token: tokens.cashier, body: { photos: [photo, photo], printImages: [PNG, PNG] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.receivable.photos.length, 3); assert.equal(r.body.receivable.printImages.length, 3);
  const over = await call('POST', `/api/receivables/${id}/photos`, { token: tokens.cashier, body: { photos: [photo, photo] } });
  assert.equal(over.status, 400); assert.match(over.body.message, /حتى 4/);
  assert.equal((await call('POST', `/api/receivables/${id}/photos`, { token: tokens.employee, body: { photos: [photo] } })).status, 403);
});

test('التسديد: الرد يحمل نسخ الطباعة (تُطبع فوراً بختم «دُفع»)', async () => {
  const r = await call('POST', `/api/receivables/${id}/pay`, { token: tokens.cashier, body: { paymentMethod: 'cash', source: 'drawer' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.receivable.status, 'paid');
  assert.equal(r.body.receivable.printImages.length, 3);
});

test('الفواتير القديمة (بلا صور) تعمل كما كانت', async () => {
  const r = await call('POST', '/api/receivables', { token: tokens.cashier, body: { customerName: 'مورّد قديم', lines: [{ name: 'خبز', quantity: 2, price: 1.25 }] } });
  assert.equal(r.status, 201);
  assert.equal(r.body.receivable.amount, 2.5);
  assert.deepEqual(r.body.receivable.photos, []);
});
