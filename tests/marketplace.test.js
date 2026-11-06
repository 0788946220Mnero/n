/**
 * منصة براق — اختبار من طرف لطرف: خادم متجر وهمي (نفس مسارات خادم البراق العامة)،
 * إضافة المتجر من الإدارة بعنوانه، المزامنة، الصفحة الرئيسية بالأقرب، الطلب توصيل/استلام،
 * التتبع، التقييم، الدردشة مع المتجر وبوابة المتجر.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'test-secret';
process.env.MKT_SYNC_DISABLED = '1';
process.env.NODE_ENV = 'test';

const { install, matches } = require('./helpers/memoryDb');
const M = require('../marketplace/models');
const PhoneUser = require('../models/PhoneUser');
const User = require('../models/User');
const CustomerProfile = require('../models/CustomerProfile');
[M.MktAppConfig, M.MktStore, M.MktProduct, M.MktOrder, M.MktReview, M.MktThread, M.MktMessage, PhoneUser, User, CustomerProfile].forEach(install);

/* ── بدائل لما لا تدعمه قاعدة الذاكرة: bulkWrite و aggregate ── */
for (const Model of [M.MktProduct, M.MktOrder]) {
  Model.bulkWrite = async (ops) => {
    for (const op of ops) {
      const u = op.updateOne;
      const hit = await Model.findOne(u.filter);
      if (hit) await Model.updateOne(u.filter, u.update);
      else if (u.upsert) await Model.create({ ...u.filter, ...(u.update.$set || {}) });
    }
    return { ok: 1 };
  };
}
async function aggregateSum(Model, pipeline) {
  const match = (pipeline.find((s) => s.$match) || {}).$match || {};
  const group = (pipeline.find((s) => s.$group) || {}).$group;
  const docs = (await Model.find({}).lean()).filter((d) => matches(d, match));
  const field = Object.keys(group).find((k) => k !== '_id');
  const groups = new Map();
  for (const d of docs) {
    const key = group._id ? String(d[String(group._id).slice(1)]) : 'all';
    const g = groups.get(key) || { _id: group._id ? d[String(group._id).slice(1)] : null, count: 0, sum: 0, n: 0 };
    g.count += 1; g.sum += Number(d.stars || 0); g.n += Number(d.unreadStore || 0);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ _id: g._id, ...(field === 'n' ? { n: g.n } : { count: g.count, sum: g.sum }) }));
}
M.MktReview.aggregate = (p) => aggregateSum(M.MktReview, p);
M.MktThread.aggregate = (p) => aggregateSum(M.MktThread, p);

/* ── خادم متجر وهمي ── */
const remoteOrders = new Map();
let remoteProducts = [];
function fakeStore() {
  const a = express();
  a.use(express.json());
  const catId = new mongoose.Types.ObjectId().toString();
  const hiddenCat = new mongoose.Types.ObjectId().toString();
  remoteProducts = [
    { _id: new mongoose.Types.ObjectId().toString(), nameAr: 'شاورما عربي', price: 2.5, category: { _id: catId, nameAr: 'شاورما' }, image: '/uploads/a.jpg', addons: [{ name: 'جبنة', price: 0.25 }], isAvailable: true, ordersCount: 30 },
    { _id: new mongoose.Types.ObjectId().toString(), nameAr: 'بروستد', price: 4, category: { _id: catId, nameAr: 'شاورما' }, image: 'https://cdn.x/b.jpg', addons: [], isAvailable: true, ordersCount: 10 },
    { _id: new mongoose.Types.ObjectId().toString(), nameAr: 'صنف مخفي', price: 1, category: { _id: hiddenCat, nameAr: 'مخفي' }, image: '', addons: [], isAvailable: true },
  ];
  a.get('/api/settings', (_q, r) => r.json({ restaurantName: 'مطعم كنزي', logo: '/uploads/logo.png', restaurantStatus: { mode: 'open' }, delivery: { enabled: true } }));
  a.get('/api/settings/delivery-config', (_q, r) => r.json({ success: true, enabled: true, restaurantLatitude: 31.95, restaurantLongitude: 35.91, maxDistanceKm: 10 }));
  a.post('/api/settings/delivery-quote', (q, r) => r.json({ success: true, fee: 1.5, distanceKm: 3.2 }));
  a.get('/api/categories', (_q, r) => r.json([{ _id: catId, nameAr: 'شاورما', order: 1, isVisible: true }, { _id: hiddenCat, nameAr: 'مخفي', isVisible: false }]));
  a.get('/api/products', (q, r) => {
    const page = Number(q.query.page) || 1; const limit = Number(q.query.limit) || 10;
    const slice = remoteProducts.slice((page - 1) * limit, page * limit);
    r.json({ data: slice, pagination: { total: remoteProducts.length, page, pages: Math.ceil(remoteProducts.length / limit), limit } });
  });
  a.post('/api/orders', (q, r) => {
    const b = q.body;
    if (!/^07\d{8}$/.test(b.phone)) return r.status(400).json({ success: false, message: 'هاتف' });
    const items = b.items.map((i) => { const p = remoteProducts.find((x) => x._id === i.product); return { product: i.product, nameAr: p.nameAr, quantity: i.quantity, price: p.price, addons: (i.addons || []).map((ad) => ({ name: ad.name, price: (p.addons.find((x) => x.name === ad.name) || {}).price || 0 })) }; });
    const itemsTotal = items.reduce((s, i) => s + (i.price + i.addons.reduce((x, y) => x + y.price, 0)) * i.quantity, 0);
    const fee = b.orderType === 'delivery' ? 1.5 : 0;
    const id = new mongoose.Types.ObjectId().toString();
    const o = { _id: id, orderNumber: `D-${remoteOrders.size + 1}`, status: 'pending', items, itemsTotal, deliveryFee: fee, total: itemsTotal + fee, orderType: b.orderType, notes: b.notes, trackingToken: `tok-${id}`, customerLatitude: b.customerLatitude };
    remoteOrders.set(id, o);
    r.status(201).json({ success: true, order: o, orderNumber: o.orderNumber, orderId: id, trackingToken: o.trackingToken });
  });
  a.post('/api/orders/track', (q, r) => r.json({ success: true, data: q.body.refs.map((x) => remoteOrders.get(x.id)).filter((o) => o && q.body.refs.some((x) => x.token === o.trackingToken)).map((o) => ({ id: o._id, status: o.status, deliveryState: '' })) }));
  return a;
}

function listen(app) { return new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); }); }

let storeSrv, hubSrv, hub, adminToken, custToken;
async function req(path, { method = 'GET', body, token, headers = {} } = {}) {
  const r = await fetch(hub + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  storeSrv = await listen(fakeStore());
  const app = express();
  app.use(express.json());
  app.use('/api/mkt', require('../marketplace').router());
  hubSrv = await listen(app);
  hub = `http://127.0.0.1:${hubSrv.address().port}`;
  const admin = await User.create({ name: 'مدير', username: 'admin', email: 'a@a.com', password: 'xxxxxx12', role: 'admin', isActive: true });
  adminToken = jwt.sign({ id: String(admin._id), sid: 's1', tv: admin.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const pu = await PhoneUser.create({ phone: '+962791234567' });
  custToken = jwt.sign({ id: String(pu._id), type: 'customer', v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
});
test.after(() => { storeSrv.close(); hubSrv.close(); });

let storeId, slug, storeKey, productId, orderId;

test('الإدارة: فحص خادم المتجر ثم إضافته ومزامنة منتجاته', async () => {
  const url = `http://127.0.0.1:${storeSrv.address().port}`;
  const p = await req('/api/mkt/admin/probe', { method: 'POST', token: adminToken, body: { url: url + '/api/' } });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  assert.strictEqual(p.body.info.name, 'مطعم كنزي');
  assert.strictEqual(p.body.info.products, 3);
  assert.deepStrictEqual(p.body.info.location, { lat: 31.95, lng: 35.91 });

  const c = await req('/api/mkt/admin/stores', { method: 'POST', token: adminToken, body: { url, kind: 'restaurant', delivery: { storeDrivers: true, buraqDrivers: true, pickup: true } } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.ok(c.body.storeKey.startsWith('brq_'));
  assert.strictEqual(c.body.sync.products, 2, 'الصنف في التصنيف المخفي لا يُجلب');
  storeId = c.body.store.id; slug = c.body.store.slug; storeKey = c.body.storeKey;
  assert.ok(c.body.store.logo.startsWith(url), 'الشعار النسبي صار رابطاً مطلقاً');

  const dup = await req('/api/mkt/admin/stores', { method: 'POST', token: adminToken, body: { url } });
  assert.strictEqual(dup.status, 409);

  const noAuth = await req('/api/mkt/admin/stores');
  assert.strictEqual(noAuth.status, 401);
});

test('الزبون: الرئيسية بالأقرب وصفحة المتجر والبحث', async () => {
  const h = await req('/api/mkt/home?lat=31.96&lng=35.92');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.stores.length, 1);
  assert.ok(h.body.stores[0].distanceKm > 0 && h.body.stores[0].distanceKm < 3);
  assert.deepStrictEqual(h.body.stores[0].delivery, { store: true, buraq: true, pickup: true });

  const s = await req(`/api/mkt/stores/${slug}`);
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.products.length, 2);
  assert.strictEqual(s.body.categories.length, 1);
  productId = s.body.products.find((x) => x.name === 'شاورما عربي').id;
  assert.ok(s.body.products.find((x) => x.name === 'شاورما عربي').image.endsWith('/uploads/a.jpg'));

  const q = await req('/api/mkt/products?q=' + encodeURIComponent('بروس'));
  assert.strictEqual(q.body.products.length, 1);
  assert.strictEqual(q.body.products[0].store.slug, slug);
});

test('منتج جديد يُضاف من لوحة المتجر يظهر بعد المزامنة، والمحذوف يختفي', async () => {
  remoteProducts.push({ _id: new mongoose.Types.ObjectId().toString(), nameAr: 'فلافل', price: 0.5, category: remoteProducts[0].category, addons: [], isAvailable: true });
  remoteProducts.splice(1, 1); // حذف البروستد
  const r = await req(`/api/mkt/admin/stores/${storeId}/sync`, { method: 'POST', token: adminToken });
  assert.strictEqual(r.status, 200);
  const s = await req(`/api/mkt/stores/${slug}`);
  assert.deepStrictEqual(s.body.products.map((p) => p.name).sort(), ['شاورما عربي', 'فلافل'].sort());
});

test('التسعيرة: سائقو المتجر من خادمه، والبراق من تسعيرة البراق', async () => {
  const a = await req('/api/mkt/quote', { method: 'POST', body: { storeId, by: 'store', lat: 31.97, lng: 35.93, itemsTotal: 5 } });
  assert.strictEqual(a.body.fee, 1.5);
  const b = await req('/api/mkt/quote', { method: 'POST', body: { storeId, by: 'buraq', lat: 31.97, lng: 35.93 } });
  assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  assert.ok(b.body.fee > 0.76, 'فتحة العداد + الكم');
});

test('الطلب: يحتاج دخولاً، ويصل خادم المتجر بأسعاره، والتتبع يقرأ حالته', async () => {
  const anon = await req('/api/mkt/orders', { method: 'POST', body: {} });
  assert.strictEqual(anon.status, 401);
  const body = { storeId, customerName: 'مروان', orderType: 'delivery', deliveryBy: 'store', lat: 31.97, lng: 35.93, address: 'خلدا', items: [{ productId, quantity: 2, addons: [{ name: 'جبنة' }, { name: 'مزيف' }] }], clientRef: 'r1' };
  const o = await req('/api/mkt/orders', { method: 'POST', token: custToken, body });
  assert.strictEqual(o.status, 201, JSON.stringify(o.body));
  assert.strictEqual(o.body.order.total, 2 * 2.75 + 1.5);
  orderId = o.body.order.id;
  const remoteO = [...remoteOrders.values()][0];
  assert.strictEqual(remoteO.customerLatitude, 31.97);
  assert.match(remoteO.notes, /تطبيق براق/);
  const again = await req('/api/mkt/orders', { method: 'POST', token: custToken, body });
  assert.strictEqual(again.body.duplicate, true, 'نفس clientRef لا يُنشئ طلباً ثانياً');
  assert.strictEqual(remoteOrders.size, 1);

  // توصيل البراق: يصل المتجر «استلام» مع ملاحظة الأجرة، والرحلة تُسجَّل خطأً إن لم يُربط متجر البراق
  const b2 = await req('/api/mkt/orders', { method: 'POST', token: custToken, body: { ...body, deliveryBy: 'buraq', clientRef: 'r2' } });
  assert.strictEqual(b2.status, 201, JSON.stringify(b2.body));
  assert.strictEqual(b2.body.order.deliveryBy, 'buraq');
  assert.match(b2.body.buraqWarning, /غير مربوط/);
  const remoteB = [...remoteOrders.values()][1];
  assert.strictEqual(remoteB.orderType, 'pickup');
  assert.match(remoteB.notes, /توصيل شركة البراق/);

  remoteO.status = 'delivered';
  const my = await req('/api/mkt/orders/my', { token: custToken });
  const mine = my.body.orders.find((x) => x.id === orderId);
  assert.strictEqual(mine.status, 'delivered');
  assert.strictEqual(mine.canReview, true);
});

test('التقييم: بعد التسليم فقط، مرة واحدة، ويحدّث متوسط المتجر والمنتج', async () => {
  const other = (await req('/api/mkt/orders/my', { token: custToken })).body.orders.find((x) => x.id !== orderId);
  const early = await req('/api/mkt/reviews', { method: 'POST', token: custToken, body: { orderId: other.id, store: { stars: 5 } } });
  assert.strictEqual(early.status, 409);
  const r = await req('/api/mkt/reviews', { method: 'POST', token: custToken, body: { orderId, store: { stars: 4, text: 'ممتاز' }, products: [{ productId, stars: 5, text: 'لذيذ' }] } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const twice = await req('/api/mkt/reviews', { method: 'POST', token: custToken, body: { orderId, store: { stars: 1 } } });
  assert.strictEqual(twice.status, 409);
  const s = await req(`/api/mkt/stores/${slug}`);
  assert.strictEqual(s.body.store.rating, 4);
  assert.strictEqual(s.body.products.find((p) => p.id === productId).rating, 5);
  const pr = await req(`/api/mkt/products/${productId}/reviews`);
  assert.strictEqual(pr.body.reviews[0].text, 'لذيذ');
});

test('الدردشة مع المتجر وبوابة المتجر بمفتاحه', async () => {
  const m = await req(`/api/mkt/chats/${storeId}/messages`, { method: 'POST', token: custToken, body: { text: 'هل يوجد توصيل لخلدا؟', name: 'مروان' } });
  assert.strictEqual(m.status, 201);
  const bad = await req('/api/mkt/portal/me', { headers: { 'x-store-key': 'brq_wrong_wrong_wrong' } });
  assert.strictEqual(bad.status, 401);
  const me = await req('/api/mkt/portal/me', { headers: { 'x-store-key': storeKey } });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.unread, 1);
  const th = await req('/api/mkt/portal/threads', { headers: { 'x-store-key': storeKey } });
  assert.strictEqual(th.body.threads.length, 1);
  const tid = th.body.threads[0].id;
  await req(`/api/mkt/portal/threads/${tid}/messages`, { headers: { 'x-store-key': storeKey } });
  const rep = await req(`/api/mkt/portal/threads/${tid}/messages`, { method: 'POST', headers: { 'x-store-key': storeKey }, body: { text: 'نعم أهلاً' } });
  assert.strictEqual(rep.status, 201);
  const list = await req('/api/mkt/chats', { token: custToken });
  assert.strictEqual(list.body.unread, 1);
  const msgs = await req(`/api/mkt/chats/${storeId}/messages`, { token: custToken });
  assert.deepStrictEqual(msgs.body.messages.map((x) => x.from), ['customer', 'store']);
  const rv = await req('/api/mkt/portal/reviews', { headers: { 'x-store-key': storeKey } });
  assert.strictEqual(rv.body.reviews.length, 2);
  const reply = await req(`/api/mkt/portal/reviews/${rv.body.reviews[0].id}/reply`, { method: 'POST', headers: { 'x-store-key': storeKey }, body: { text: 'شكراً لك' } });
  assert.strictEqual(reply.body.review.reply, 'شكراً لك');
});

test('الإدارة: متجر موقوف يختفي من التطبيق', async () => {
  await req(`/api/mkt/admin/stores/${storeId}`, { method: 'PUT', token: adminToken, body: { active: false } });
  const h = await req('/api/mkt/home');
  assert.strictEqual(h.body.stores.length, 0);
  const s = await req(`/api/mkt/stores/${slug}`);
  assert.strictEqual(s.status, 404);
});

test('مقدمة شاشة البدء: لا شيء افتراضياً، وتُفعَّل بوسيط من لوحة البراق فقط', async () => {
  const a = await req('/api/mkt/app-config');
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.intro.enabled, false, 'بلا مقدمة = لا تأخير');
  const bad = await req('/api/mkt/admin/app-config', { method: 'PUT', token: adminToken, body: { intro: { enabled: true } } });
  assert.strictEqual(bad.status, 400);
  const notHttps = await req('/api/mkt/admin/app-config', { method: 'PUT', token: adminToken, body: { intro: { url: 'http://x/y.jpg' } } });
  assert.strictEqual(notHttps.status, 400);
  const ok = await req('/api/mkt/admin/app-config', { method: 'PUT', token: adminToken, body: { intro: { enabled: true, type: 'video', url: 'https://cdn.x/intro.mp4', durationMs: 9000 } } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const b = await req('/api/mkt/app-config');
  assert.deepStrictEqual([b.body.intro.enabled, b.body.intro.type, b.body.intro.durationMs], [true, 'video', 5000]);
  assert.ok(b.body.intro.version > 0);
  await req('/api/mkt/admin/app-config', { method: 'PUT', token: adminToken, body: { intro: { enabled: false } } });
  const c = await req('/api/mkt/app-config');
  assert.strictEqual(c.body.intro.enabled, false);
  assert.strictEqual(c.body.intro.url, '');
  const anon = await req('/api/mkt/admin/app-config', { method: 'PUT', body: { intro: { enabled: false } } });
  assert.strictEqual(anon.status, 401);
});
