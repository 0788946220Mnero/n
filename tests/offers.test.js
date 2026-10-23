/**
 * العروض الترويجية: الإدارة بصلاحية، الرابط العام، صفحة المشاركة (وسوم og للزواحف وتحويل للزبون)،
 * والخصم الثابت يُحسب في الخادم عند الطلب.
 *   node --test tests/offers.test.js
 */
process.env.JWT_SECRET = 'offers-secret-0123456789abcdef';
delete process.env.PUBLIC_SITE_URL;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Offer', 'Product', 'Category', 'Setting', 'ActivityLog', 'Order', 'Customer', 'BlockedPhone', 'Counter'].forEach((m) => { try { require(`../models/${m}`); } catch (_) { /* */ } });
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
require('../services/realtimeService').emitOrderCreated = () => {};
require('../services/pushService').notifyNewOrder = async () => {};
require('../services/staffAlertService').emit = () => {};

let server; let base; const tok = {}; const ids = {};
const call = async (method, url, { token, body, ua } = {}) => {
  const r = await fetch(base + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ua ? { 'User-Agent': ua } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* html */ }
  return { status: r.status, body: json, text };
};
const FB = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const day = 86400000;

test.before(async () => {
  const app = express(); app.set('trust proxy', true); app.use(express.json());
  app.use('/api/offers', require('../routes/offerRoutes'));
  app.get('/o/:code', require('../controllers/offerController').sharePage);
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, role] of [['admin', 'admin'], ['manager', 'manager'], ['cashier', 'cashier'], ['observer', 'observer']]) {
    const u = await M('User').create({ name: k, username: k, password: 'x'.repeat(20), role, isActive: true, permissions: [] });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  }
  const shaw = await M('Category').create({ nameAr: 'شاورما' });
  const sweets = await M('Category').create({ nameAr: 'حلويات' });
  ids.shaw = String(shaw._id); ids.sweets = String(sweets._id);
  ids.meal = String((await M('Product').create({ nameAr: 'وجبة شاورما عربي', price: 4.5, category: shaw._id, image: '/uploads/meal.jpg', isAvailable: true, addons: [{ name: 'جبنة', price: 0.5 }] }))._id);
  ids.sandwich = String((await M('Product').create({ nameAr: 'ساندويش', price: 1.25, category: shaw._id, isAvailable: true }))._id);
  ids.kunafa = String((await M('Product').create({ nameAr: 'كنافة', price: 2, category: sweets._id, isAvailable: true }))._id);
  await M('Setting').create({ restaurantName: 'مطاعم ديار الأنباط', logo: 'https://img.example/logo.png' });
});
test.after(() => server && server.close());

test('الصلاحية: المدير ينشئ، الكاشير والمراقب لا', async () => {
  const body = { title: 'وجبة الجمعة', targetType: 'product', product: ids.meal, discount: 1 };
  assert.equal((await call('POST', '/api/offers', { token: tok.cashier, body })).status, 403);
  assert.equal((await call('POST', '/api/offers', { token: tok.observer, body })).status, 403);
  assert.equal((await call('GET', '/api/offers', { token: tok.cashier })).status, 403);
  const r = await call('POST', '/api/offers', { token: tok.manager, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.mealOffer = r.body.offer._id; ids.mealCode = r.body.offer.code;
  assert.match(ids.mealCode, /^[a-z0-9]{6,12}$/);
  assert.equal(r.body.offer.shareUrl, `https://diyaralanbat.com/o/${ids.mealCode}`);
  assert.equal(r.body.offer.live, true);
  assert.equal(r.body.offer.product.nameAr, 'وجبة شاورما عربي');
});

test('التحقق: خصم أكبر من السعر، هدف ناقص، تواريخ معكوسة', async () => {
  const t = tok.admin;
  assert.match((await call('POST', '/api/offers', { token: t, body: { title: 'x', targetType: 'product', product: ids.sandwich, discount: 1.25 } })).body.message, /أقل من سعر الصنف/);
  assert.match((await call('POST', '/api/offers', { token: t, body: { title: 'x', targetType: 'product' } })).body.message, /اختر الصنف/);
  assert.match((await call('POST', '/api/offers', { token: t, body: { title: 'x', targetType: 'category' } })).body.message, /اختر التصنيف/);
  assert.match((await call('POST', '/api/offers', { token: t, body: { title: '', targetType: 'product', product: ids.meal } })).body.message, /عنوان العرض/);
  assert.match((await call('POST', '/api/offers', { token: t, body: { title: 'x', targetType: 'product', product: ids.meal, startDate: '2026-11-10', endDate: '2026-11-01' } })).body.message, /بعد البداية/);
  assert.match((await call('POST', '/api/offers', { token: t, body: { title: 'x', targetType: 'product', product: ids.meal, discount: -1 } })).body.message, /رقم موجب/);
});

test('عرض على تصنيف + القائمة', async () => {
  const r = await call('POST', '/api/offers', { token: tok.admin, body: { title: 'أسبوع الشاورما', description: 'خصم على كل أصناف الشاورما', targetType: 'category', category: ids.shaw, discount: 0.5, endDate: new Date(Date.now() + 7 * day).toISOString() } });
  assert.equal(r.status, 201);
  ids.catOffer = r.body.offer._id; ids.catCode = r.body.offer.code;
  const l = await call('GET', '/api/offers', { token: tok.manager });
  assert.equal(l.body.offers.length, 2);
  const c = l.body.offers.find((o) => o.code === ids.catCode);
  assert.equal(c.category.nameAr, 'شاورما'); assert.equal(c.state, 'live');
});

test('الرابط العام للموقع: فعّال ← بياناته؛ موقوف ← 410؛ مجهول ← 404', async () => {
  const r = await call('GET', `/api/offers/public/${ids.mealCode}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.offer.discount, 1);
  assert.equal(r.body.offer.product.price, 4.5);
  assert.equal(r.body.offer.targetType, 'product');
  assert.ok(!('createdBy' in r.body.offer) && !('views' in r.body.offer), 'بلا حقول إدارية');
  assert.equal((await call('GET', '/api/offers/public/zzzzzz')).status, 404);
  assert.equal((await call('GET', '/api/offers/public/../../x')).status, 404);

  const stop = await call('PUT', `/api/offers/${ids.catOffer}`, { token: tok.admin, body: { isActive: false } });
  assert.equal(stop.body.offer.state, 'stopped');
  const g = await call('GET', `/api/offers/public/${ids.catCode}`);
  assert.equal(g.status, 410); assert.equal(g.body.code, 'OFFER_ENDED');
  await call('PUT', `/api/offers/${ids.catOffer}`, { token: tok.admin, body: { isActive: true } });
});

test('صفحة المشاركة لفيسبوك: العنوان والسعر والصورة الكاملة، بلا تحويل ولا عدّ مشاهدة', async () => {
  const r = await call('GET', `/o/${ids.mealCode}`, { ua: FB });
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta property="og:title" content="وجبة الجمعة \| مطاعم ديار الأنباط">/);
  assert.match(r.text, /<meta property="og:description" content="بدل 4.50 د.أ ← 3.50 د.أ — اطلب مباشرة الآن">/);
  assert.match(r.text, new RegExp(`<meta property="og:image" content="http://127\\.0\\.0\\.1:\\d+/uploads/meal\\.jpg">`), 'صورة الصنف كرابط كامل');
  assert.match(r.text, new RegExp(`<meta property="og:url" content="https://diyaralanbat\\.com/o/${ids.mealCode}">`));
  assert.match(r.text, /twitter:card" content="summary_large_image"/);
  assert.ok(!r.text.includes('location.replace') && !r.text.includes('http-equiv="refresh"'), 'الزاحف لا يُحوَّل');
  assert.equal((await M('Offer').findById(ids.mealOffer).lean()).views, 0);
  const wa = await call('GET', `/o/${ids.mealCode}`, { ua: 'WhatsApp/2.23.20.0 A' });
  assert.ok(wa.text.includes('og:image') && !wa.text.includes('location.replace'), 'واتساب أيضاً زاحف');
});

test('صفحة المشاركة للزبون: تحويل فوري للعرض في الموقع وتُعدّ مشاهدة', async () => {
  const r = await call('GET', `/o/${ids.mealCode}`, { ua: PHONE });
  assert.ok(r.text.includes(`location.replace("https://diyaralanbat.com/?offer=${ids.mealCode}")`));
  assert.ok(r.text.includes(`http-equiv="refresh" content="0;url=https://diyaralanbat.com/?offer=${ids.mealCode}"`));
  await new Promise((x) => setTimeout(x, 30));
  assert.equal((await M('Offer').findById(ids.mealOffer).lean()).views, 1);
});

test('فيديو: og:video mp4 مع الغلاف صورةً للمعاينة', async () => {
  await M('Offer').updateOne({ _id: ids.mealOffer }, { $set: { mediaUrl: 'https://cdn.example/promo.mp4', mediaType: 'video', coverUrl: 'https://cdn.example/cover.jpg' } });
  const r = await call('GET', `/o/${ids.mealCode}`, { ua: FB });
  assert.match(r.text, /og:type" content="video.other"/);
  assert.match(r.text, /og:video:secure_url" content="https:\/\/cdn.example\/promo.mp4"/);
  assert.match(r.text, /og:video:type" content="video\/mp4"/);
  assert.match(r.text, /og:image" content="https:\/\/cdn.example\/cover.jpg"/);
  // صورة مرفوعة بدل الفيديو
  await M('Offer').updateOne({ _id: ids.mealOffer }, { $set: { mediaUrl: 'https://cdn.example/promo.jpg', mediaType: 'image', coverUrl: '' } });
  const i = await call('GET', `/o/${ids.mealCode}`, { ua: FB });
  assert.match(i.text, /og:image" content="https:\/\/cdn.example\/promo.jpg"/);
  assert.ok(!i.text.includes('og:video'));
});

test('رابط عرض مجهول أو منتهٍ: صفحة المطعم العامة لا خطأ', async () => {
  const r = await call('GET', '/o/nothere', { ua: FB });
  assert.equal(r.status, 200);
  assert.match(r.text, /og:title" content="مطاعم ديار الأنباط"/);
  assert.match(r.text, /og:image" content="https:\/\/img.example\/logo.png"/);
  const h = await call('GET', '/o/nothere', { ua: PHONE });
  assert.ok(h.text.includes('location.replace("https://diyaralanbat.com/?offer=nothere")'), 'الزبون يصل للموقع ويرى «انتهى العرض»');
});

test('النص في الوسوم مُهرَّب (لا حقن HTML)', async () => {
  const r = await call('POST', '/api/offers', { token: tok.admin, body: { title: 'عرض "خاص" <script>alert(1)</script>', targetType: 'product', product: ids.kunafa } });
  const p = await call('GET', `/o/${r.body.offer.code}`, { ua: FB });
  assert.ok(!p.text.includes('<script>alert(1)</script>'));
  assert.ok(p.text.includes('&quot;خاص&quot; &lt;script&gt;'));
  await call('DELETE', `/api/offers/${r.body.offer._id}`, { token: tok.admin });
});

/* ─── التسعير في الخادم ─── */
const { priceOrderItems } = require('../services/pricingService');

test('الطلب بسعر العرض: الخصم على الصنف لا الإضافات، ومن القاعدة لا الجهاز', async () => {
  const r = await priceOrderItems([{ product: ids.meal, offer: ids.mealOffer, quantity: 2, price: 0.01, addons: [{ name: 'جبنة' }] }]);
  assert.ok(!r.error, r.error);
  assert.equal(r.items[0].price, 4, '4.5 − 1 + 0.5 جبنة');
  assert.equal(r.items[0].offerDiscount, 1);
  assert.equal(String(r.items[0].offer), ids.mealOffer);
  assert.equal(r.itemsTotal, 8);
});

test('عرض التصنيف: يخص أصنافه فقط، ولا يقل السعر عن صفر', async () => {
  const r = await priceOrderItems([
    { product: ids.sandwich, offer: ids.catOffer, quantity: 1 },
    { product: ids.kunafa, offer: ids.catOffer, quantity: 1 }, // ليست من الشاورما ← سعر عادي
  ]);
  assert.equal(r.items[0].price, 0.75);
  assert.equal(r.items[1].price, 2); assert.equal(r.items[1].offer, undefined);
  await M('Offer').updateOne({ _id: ids.catOffer }, { $set: { discount: 5 } });
  const z = await priceOrderItems([{ product: ids.sandwich, offer: ids.catOffer, quantity: 1 }]);
  assert.equal(z.items[0].price, 0);
  await M('Offer').updateOne({ _id: ids.catOffer }, { $set: { discount: 0.5 } });
});

test('عرض انتهى قبل الإرسال: يُرفض الطلب برسالة واضحة (لا يُحاسَب بسعر مختلف بصمت)', async () => {
  await M('Offer').updateOne({ _id: ids.catOffer }, { $set: { endDate: new Date(Date.now() - 1000) } });
  const r = await priceOrderItems([{ product: ids.sandwich, offer: ids.catOffer, quantity: 1 }]);
  assert.equal(r.code, 'OFFER_ENDED');
  assert.match(r.error, /انتهى العرض: أسبوع الشاورما/);
  const gone = await priceOrderItems([{ product: ids.sandwich, offer: '64b000000000000000000000', quantity: 1 }]);
  assert.equal(gone.code, 'OFFER_ENDED', 'عرض محذوف كذلك');
  const plain = await priceOrderItems([{ product: ids.sandwich, quantity: 1 }]);
  assert.equal(plain.items[0].price, 1.25, 'بلا عرض: السعر العادي كما كان');
  await M('Offer').updateOne({ _id: ids.catOffer }, { $set: { endDate: new Date(Date.now() + 7 * day) } });
});

test('طلب الموقع الكامل: يُحفظ بسعر العرض ويزيد عدّاد طلبات العرض', async () => {
  const { createOrder } = require('../controllers/orderController');
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const before = (await M('Offer').findById(ids.mealOffer).lean()).orders || 0;
  await createOrder({ body: { customerName: 'زبون فيسبوك', phone: '0791234567', total: 1, orderType: 'pickup', items: [{ product: ids.meal, offer: ids.mealOffer, quantity: 1, price: 4.5 }] } }, res, (e) => { throw e; });
  assert.equal(res.code, 201, JSON.stringify(res.body));
  const order = await M('Order').findOne({ customerName: 'زبون فيسبوك' }).lean();
  assert.equal(order.items[0].price, 3.5);
  assert.equal(order.items[0].offerDiscount, 1);
  assert.equal(order.total, 3.5);
  await new Promise((x) => setTimeout(x, 30));
  assert.equal((await M('Offer').findById(ids.mealOffer).lean()).orders, before + 1);
});
