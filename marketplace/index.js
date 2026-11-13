/**
 * منصة براق — تطبيق الزبائن متعدد المتاجر.
 *
 *   app.use('/api/mkt', require('./marketplace').router());   // server.js
 *   require('./marketplace').start();                         // المزامنة الدورية بعد التشغيل
 *
 * العامة (تطبيق براق):
 *   GET  /api/mkt/home?lat&lng                 المتاجر القريبة + منتجات مختارة
 *   GET  /api/mkt/stores?lat&lng&kind&q        المتاجر مرتبة بالأقرب
 *   GET  /api/mkt/stores/:slug?lat&lng         المتجر + التصنيفات + المنتجات (يحدّث من خادمه إن قدُمت النسخة)
 *   GET  /api/mkt/products?q&lat&lng&kind      بحث المنتجات في كل المتاجر
 *   GET  /api/mkt/stores/:id/reviews           تقييمات المتجر
 *   GET  /api/mkt/products/:id/reviews         تقييمات المنتج
 *   POST /api/mkt/quote                        تسعيرة التوصيل (سائقو المتجر أو البراق)
 * الزبون (توكن دخول الهاتف + PIN نفسه في /api/auth/pin):
 *   GET  /api/mkt/me · PUT /api/mkt/me {name}
 *   POST /api/mkt/orders · GET /api/mkt/orders/my
 *   POST /api/mkt/reviews
 *   GET  /api/mkt/chats · GET/POST /api/mkt/chats/:storeId/messages
 * الإدارة (mkt:manage):   /api/mkt/admin/*
 * بوابة المتجر (x-store-key): /api/mkt/portal/*
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { MktStore, MktProduct, MktOrder, MktReview, MktThread, MktMessage, MktAppConfig } = require('./models');
const svc = require('./service');
const remote = require('./remote');

const { httpError } = remote;
const validId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const fromQuery = (q) => { const p = { lat: num(q.lat), lng: num(q.lng) }; return svc.isPoint(p) ? p : null; };
const escRx = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60);
const clean = (t, n = 1000) => String(t || '').replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim().slice(0, n);
const localJo = (intl) => (String(intl || '').startsWith('+962') ? `0${String(intl).slice(4)}` : String(intl || ''));

function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
const limiter = (max, windowMs = 60 * 1000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'طلبات كثيرة — انتظر قليلاً' } });

/* ═════════════ إعدادات التطبيق (مقدمة شاشة البدء) ═════════════ */
async function appConfig() {
  let c = await MktAppConfig.findOne({ key: 'app' });
  if (!c) { try { c = await MktAppConfig.create({ key: 'app' }); } catch (_) { c = await MktAppConfig.findOne({ key: 'app' }); } }
  return c;
}
/** ما يقرؤه التطبيق عند كل فتح: لا مقدمة = لا تأخير. version يتغيّر مع كل تعديل فيعيد التطبيق تحميل الوسيط. */
function introView(c) {
  const i = (c && c.intro) || {};
  const on = !!(i.enabled && i.url && (i.type === 'image' || i.type === 'video'));
  return {
    enabled: on, type: on ? i.type : 'none', url: on ? i.url : '',
    durationMs: Math.max(1000, Math.min(5000, Number(i.durationMs) || 2000)), skippable: i.skippable !== false,
    version: c && c.updatedAt ? new Date(c.updatedAt).getTime() : 0,
  };
}

async function displayName(phoneUser, fallback) {
  try {
    const p = await require('../services/customerProfileService').forPhoneUser(phoneUser);
    if (p && p.displayName) return p.displayName;
  } catch (_) {}
  return String(fallback || '').trim().slice(0, 40) || 'زبون';
}

/** المتاجر الفعّالة مرتبة بالأقرب (أو المميزة ثم الترتيب اليدوي بلا موقع). */
async function listStores({ from, kind, q, limit = 60 }) {
  const filter = { active: true };
  if (kind === 'restaurant' || kind === 'store') filter.kind = kind;
  if (q) filter.$or = [{ name: { $regex: escRx(q), $options: 'i' } }, { tags: { $regex: escRx(q), $options: 'i' } }];
  const stores = await MktStore.find(filter).limit(300).lean();
  const views = stores.map((s) => svc.storeView(s, from));
  views.sort((a, b) => {
    if (a.status !== 'stopped' && b.status === 'stopped') return -1;
    if (b.status !== 'stopped' && a.status === 'stopped') return 1;
    if (from && a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return 0;
  });
  return views.slice(0, limit);
}

/* ═══════════════════════════ العامة + الزبون ═══════════════════════════ */
function publicRouter() {
  const r = express.Router();
  const { requireCustomer } = require('../middlewares/phoneAuth');

  r.get('/health', (_req, res) => res.json({ success: true, service: 'buraq-platform' }));

  // إعدادات التطبيق عند الفتح (مقدمة شاشة البدء) — خفيفة وتُخبّأ دقيقة
  r.get('/app-config', wrap(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, intro: introView(await appConfig()) });
  }));

  r.get('/home', wrap(async (req, res) => {
    const from = fromQuery(req.query);
    const stores = await listStores({ from, kind: req.query.kind });
    const openIds = stores.filter((s) => s.status !== 'stopped').slice(0, 15).map((s) => s.id);
    const prods = openIds.length
      ? await MktProduct.find({ store: { $in: openIds }, available: true, image: { $ne: '' } }).sort({ popularity: -1, 'rating.sum': -1 }).limit(80).lean()
      : [];
    // تنويع: حتى 4 منتجات من كل متجر، الأقرب أولاً
    const per = new Map();
    const rank = new Map(openIds.map((id, i) => [id, i]));
    const picked = prods.filter((p) => { const k = String(p.store); const n = per.get(k) || 0; if (n >= 4) return false; per.set(k, n + 1); return true; })
      .sort((a, b) => (rank.get(String(a.store)) - rank.get(String(b.store))) || (b.popularity - a.popularity)).slice(0, 24);
    const storeById = new Map((await MktStore.find({ _id: { $in: [...per.keys()] } }).select('slug name logo').lean()).map((s) => [String(s._id), s]));
    res.json({ success: true, stores, products: picked.map((p) => svc.productView(p, storeById.get(String(p.store)))) });
  }));

  r.get('/stores', wrap(async (req, res) => {
    res.json({ success: true, stores: await listStores({ from: fromQuery(req.query), kind: req.query.kind, q: req.query.q }) });
  }));

  r.get('/stores/:slug', wrap(async (req, res) => {
    const key = String(req.params.slug || '').toLowerCase();
    const store = await MktStore.findOne(validId(key) ? { _id: key } : { slug: key }).lean();
    if (!store || !store.active) throw httpError(404, 'المتجر غير موجود');
    svc.refreshIfStale(store);
    const products = await MktProduct.find({ store: store._id }).sort({ order: 1, name: 1 }).lean();
    res.json({
      success: true,
      store: svc.storeView(store, fromQuery(req.query)),
      categories: (store.remote && store.remote.categories) || [],
      products: products.map((p) => svc.productView(p)),
      syncedAt: store.sync && store.sync.at,
    });
  }));

  r.get('/products', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const from = fromQuery(req.query);
    const stores = await listStores({ from, kind: req.query.kind, limit: 300 });
    const ids = stores.filter((s) => s.status !== 'stopped').map((s) => s.id);
    const filter = { store: { $in: ids }, available: true };
    if (q) filter.$or = [{ name: { $regex: escRx(q), $options: 'i' } }, { nameEn: { $regex: escRx(q), $options: 'i' } }, { categoryName: { $regex: escRx(q), $options: 'i' } }];
    const prods = await MktProduct.find(filter).sort({ popularity: -1 }).limit(200).lean();
    const rank = new Map(ids.map((id, i) => [id, i]));
    prods.sort((a, b) => rank.get(String(a.store)) - rank.get(String(b.store)));
    const storeById = new Map(stores.map((s) => [s.id, { _id: s.id, slug: s.slug, name: s.name, logo: s.logo }]));
    res.json({ success: true, products: prods.slice(0, 60).map((p) => ({ ...svc.productView(p, storeById.get(String(p.store))), distanceKm: (stores.find((s) => s.id === String(p.store)) || {}).distanceKm ?? null })) });
  }));

  r.get('/stores/:id/reviews', wrap(async (req, res) => {
    if (!validId(req.params.id)) throw httpError(400, 'معرّف غير صالح');
    const list = await MktReview.find({ store: req.params.id, product: null, hidden: { $ne: true } }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, reviews: list.map(svc.reviewView) });
  }));
  r.get('/products/:id/reviews', wrap(async (req, res) => {
    if (!validId(req.params.id)) throw httpError(400, 'معرّف غير صالح');
    const list = await MktReview.find({ product: req.params.id, hidden: { $ne: true } }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, reviews: list.map(svc.reviewView) });
  }));

  r.post('/quote', limiter(40), wrap(async (req, res) => {
    const b = req.body || {};
    if (!validId(b.storeId)) throw httpError(400, 'المتجر غير صالح');
    const store = await MktStore.findById(b.storeId).lean();
    if (!store || !store.active) throw httpError(404, 'المتجر غير متاح');
    res.json({ success: true, ...(await svc.quote(store, { by: b.by === 'buraq' ? 'buraq' : 'store', lat: b.lat, lng: b.lng, itemsTotal: b.itemsTotal })) });
  }));

  /* ── الزبون ── */
  r.get('/me', requireCustomer, wrap(async (req, res) => {
    const name = await displayName(req.phoneUser, '');
    res.json({ success: true, user: { id: String(req.phoneUser._id), phone: localJo(req.phoneUser.phone), name: name === 'زبون' ? '' : name } });
  }));
  r.put('/me', requireCustomer, wrap(async (req, res) => {
    const name = clean(req.body && req.body.name, 30).replace(/\s+/g, ' ');
    if (name.length < 2) throw httpError(400, 'الاسم بين حرفين و30 حرفاً');
    if (/^[\d\s+]+$/.test(name)) throw httpError(400, 'اختر اسماً لا رقماً');
    if (/فريق|إدارة|ادارة|admin|staff|براق|البراق/i.test(name)) throw httpError(422, 'هذا الاسم محجوز');
    const P = require('../services/customerProfileService');
    const CustomerProfile = require('../models/CustomerProfile');
    const p = await P.forPhoneUser(req.phoneUser);
    await CustomerProfile.updateOne({ _id: p._id }, { $set: { displayName: name } });
    res.json({ success: true, user: { id: String(req.phoneUser._id), phone: localJo(req.phoneUser.phone), name } });
  }));

  r.post('/orders', requireCustomer, limiter(10), wrap(async (req, res) => {
    const { order, duplicate } = await svc.placeOrder(req.phoneUser, req.body || {});
    const store = await MktStore.findById(order.store).select('slug name logo').lean();
    res.status(duplicate ? 200 : 201).json({ success: true, duplicate: !!duplicate, order: svc.orderView(order, store), buraqWarning: order.brqError || '' });
  }));

  r.get('/orders/my', requireCustomer, wrap(async (req, res) => {
    const orders = await MktOrder.find({ phoneUser: req.phoneUser._id }).sort({ createdAt: -1 }).limit(40).lean();
    await svc.refreshStatuses(orders.slice(0, 15));
    const stores = new Map((await MktStore.find({ _id: { $in: [...new Set(orders.map((o) => String(o.store)))] } }).select('slug name logo').lean()).map((s) => [String(s._id), s]));
    res.json({ success: true, orders: orders.map((o) => svc.orderView(o, stores.get(String(o.store)))) });
  }));

  r.post('/reviews', requireCustomer, limiter(10), wrap(async (req, res) => {
    const name = await displayName(req.phoneUser, req.body && req.body.name);
    res.status(201).json({ success: true, ...(await svc.submitReview(req.phoneUser, req.body || {}, name)) });
  }));

  /* ── دردشة الزبون مع المتاجر ── */
  r.get('/chats', requireCustomer, wrap(async (req, res) => {
    const threads = await MktThread.find({ phoneUser: req.phoneUser._id }).sort({ lastAt: -1 }).limit(50).lean();
    const stores = new Map((await MktStore.find({ _id: { $in: threads.map((t) => t.store) } }).select('slug name logo').lean()).map((s) => [String(s._id), s]));
    res.json({
      success: true,
      threads: threads.filter((t) => stores.has(String(t.store))).map((t) => {
        const s = stores.get(String(t.store));
        return { storeId: String(t.store), slug: s.slug, name: s.name, logo: s.logo || '', lastText: t.lastText, lastAt: t.lastAt, unread: t.unreadCustomer || 0 };
      }),
      unread: threads.reduce((n, t) => n + (t.unreadCustomer || 0), 0),
    });
  }));

  r.get('/chats/:storeId/messages', requireCustomer, wrap(async (req, res) => {
    if (!validId(req.params.storeId)) throw httpError(400, 'معرّف غير صالح');
    const t = await MktThread.findOne({ store: req.params.storeId, phoneUser: req.phoneUser._id });
    if (!t) return res.json({ success: true, messages: [] });
    const filter = { thread: t._id };
    if (req.query.after) { const d = new Date(req.query.after); if (!isNaN(d)) filter.createdAt = { $gt: d }; }
    const msgs = await MktMessage.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    if (t.unreadCustomer) { t.unreadCustomer = 0; await t.save(); }
    res.json({ success: true, messages: msgs.reverse().map(msgView) });
  }));

  r.post('/chats/:storeId/messages', requireCustomer, limiter(20), wrap(async (req, res) => {
    if (!validId(req.params.storeId)) throw httpError(400, 'معرّف غير صالح');
    const store = await MktStore.findById(req.params.storeId).select('active name').lean();
    if (!store || !store.active) throw httpError(404, 'المتجر غير متاح');
    const text = clean(req.body && req.body.text);
    if (!text) throw httpError(400, 'اكتب رسالتك');
    const name = await displayName(req.phoneUser, req.body && req.body.name);
    const t = await MktThread.findOneAndUpdate(
      { store: store._id, phoneUser: req.phoneUser._id },
      { $set: { customerName: name, phone: localJo(req.phoneUser.phone), lastText: text.slice(0, 120), lastAt: new Date() }, $inc: { unreadStore: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const m = await MktMessage.create({ thread: t._id, from: 'customer', byName: name, text });
    res.status(201).json({ success: true, message: msgView(m) });
  }));

  return r;
}

function msgView(m) { return { id: String(m._id), from: m.from, byName: m.byName || '', text: m.text, createdAt: m.createdAt }; }

/* ═══════════════════════════ الإدارة (لوحة البراق) ═══════════════════════════ */
function adminRouter() {
  const r = express.Router();
  const { protect } = require('../middlewares/auth');
  const { requirePermission } = require('../middlewares/permission');
  r.use(protect, requirePermission('mkt:manage'));

  const adminStore = (s) => ({
    ...svc.storeView(s, null),
    baseUrl: s.baseUrl, active: !!s.active, sortOrder: s.sortOrder || 0, keyHint: s.keyHint || '',
    deliveryConfig: s.delivery || {}, sync: s.sync || {}, remote: { ...(s.remote || {}), categories: undefined },
    ordersCount: s.ordersCount || 0, createdAt: s.createdAt,
  });

  function applyBody(store, b) {
    if (b.name !== undefined) store.name = clean(b.name, 80);
    if (b.kind !== undefined) store.kind = b.kind === 'store' ? 'store' : 'restaurant';
    if (b.tags !== undefined) store.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[،,]/)).map((t) => clean(t, 30)).filter(Boolean).slice(0, 10);
    for (const k of ['logo', 'cover', 'phone', 'whatsapp']) if (b[k] !== undefined) store[k] = clean(b[k], 400);
    if (b.address !== undefined) store.address = clean(b.address, 160);
    if (b.description !== undefined) store.description = clean(b.description, 400);
    if (b.active !== undefined) store.active = !!b.active;
    if (b.featured !== undefined) store.featured = !!b.featured;
    if (b.sortOrder !== undefined) store.sortOrder = Number(b.sortOrder) || 0;
    if (b.lat !== undefined && b.lng !== undefined) {
      const p = { lat: Number(b.lat), lng: Number(b.lng) };
      if (b.lat === '' || b.lat === null) store.location = undefined;
      else if (svc.isPoint(p)) store.location = { type: 'Point', coordinates: [p.lng, p.lat] };
      else throw httpError(400, 'إحداثيات الموقع غير صالحة');
    }
    if (b.delivery && typeof b.delivery === 'object') {
      const d = b.delivery; const cur = store.delivery || {};
      const n = (v, def) => (v === undefined ? def : Math.max(0, Number(v) || 0));
      store.delivery = {
        storeDrivers: d.storeDrivers === undefined ? cur.storeDrivers : !!d.storeDrivers,
        buraqDrivers: d.buraqDrivers === undefined ? cur.buraqDrivers : !!d.buraqDrivers,
        pickup: d.pickup === undefined ? cur.pickup : !!d.pickup,
        buraqMode: d.buraqMode === undefined ? cur.buraqMode : d.buraqMode === 'custom' ? 'custom' : 'meter',
        buraqBaseFils: n(d.buraqBaseFils, cur.buraqBaseFils),
        buraqPerKmFils: n(d.buraqPerKmFils, cur.buraqPerKmFils),
        buraqMaxKm: n(d.buraqMaxKm, cur.buraqMaxKm),
        brqStore: d.brqStore === undefined ? cur.brqStore : (validId(d.brqStore) ? d.brqStore : null),
      };
    }
  }

  /* ── إعدادات التطبيق: مقدمة قبل شعار البدء ── */
  r.get('/app-config', wrap(async (_req, res) => {
    const c = await appConfig();
    res.json({ success: true, intro: { ...introView(c), enabled: !!(c.intro && c.intro.enabled), rawType: (c.intro && c.intro.type) || 'none', rawUrl: (c.intro && c.intro.url) || '' }, updatedAt: c.updatedAt, updatedBy: c.updatedBy || '' });
  }));
  r.put('/app-config', wrap(async (req, res) => {
    const b = (req.body && req.body.intro) || {};
    const c = await appConfig();
    const cur = (c.intro && c.intro.toObject ? c.intro.toObject() : c.intro) || {};
    const next = { ...cur };
    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (b.type !== undefined) next.type = ['image', 'video'].includes(b.type) ? b.type : 'none';
    if (b.url !== undefined) {
      const u = String(b.url || '').trim();
      if (u && !/^https:\/\//i.test(u)) throw httpError(400, 'رابط الوسيط يجب أن يبدأ بـ https://');
      next.url = u.slice(0, 600);
    }
    if (b.durationMs !== undefined) next.durationMs = Math.max(1000, Math.min(5000, Math.round(Number(b.durationMs) || 2000)));
    if (b.skippable !== undefined) next.skippable = !!b.skippable;
    if (next.enabled && (!next.url || next.type === 'none')) throw httpError(400, 'ارفع صورة أو فيديو أولاً، أو أوقف المقدمة');
    c.intro = next;
    c.updatedBy = (req.user && req.user.name) || '';
    c.markModified('intro');
    await c.save();
    res.json({ success: true, intro: introView(c) });
  }));
  r.post('/app-config/intro-media', (req, res, next) => {
    require('../middlewares/upload').uploadMedia.single('media')(req, res, (err) => (err ? next(Object.assign(err, { status: err.status || err.statusCode || 400 })) : next()));
  }, wrap(async (req, res) => {
    if (!req.file || !req.file.path) throw httpError(400, 'لم يُرفق ملف');
    const isVideo = /^video\//i.test(req.file.mimetype || '') || /\.(mp4|webm|mov)$/i.test(req.file.originalname || '');
    const isImage = /^image\//i.test(req.file.mimetype || '');
    if (!isVideo && !isImage) throw httpError(415, 'الملف يجب أن يكون صورة أو فيديو MP4');
    const c = await appConfig();
    c.intro = { ...((c.intro && c.intro.toObject ? c.intro.toObject() : c.intro) || {}), type: isVideo ? 'video' : 'image', url: req.file.path, enabled: true };
    c.updatedBy = (req.user && req.user.name) || '';
    c.markModified('intro');
    await c.save();
    res.json({ success: true, intro: introView(c) });
  }));

  r.post('/probe', wrap(async (req, res) => {
    const info = await remote.probe(req.body && req.body.url);
    const existing = await MktStore.findOne({ baseUrl: info.baseUrl }).select('name slug').lean();
    res.json({ success: true, info, existing: existing ? { id: String(existing._id), name: existing.name, slug: existing.slug } : null });
  }));

  r.get('/stores', wrap(async (_req, res) => {
    const list = await MktStore.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
    const unread = await MktThread.aggregate([{ $group: { _id: '$store', n: { $sum: '$unreadStore' } } }]);
    const un = new Map(unread.map((u) => [String(u._id), u.n]));
    res.json({ success: true, stores: list.map((s) => ({ ...adminStore(s), unreadChats: un.get(String(s._id)) || 0 })), syncEveryMin: svc.SYNC_EVERY_MIN });
  }));

  r.post('/stores', wrap(async (req, res) => {
    const b = req.body || {};
    const info = await remote.probe(b.url || b.baseUrl);
    if (await MktStore.exists({ baseUrl: info.baseUrl })) throw httpError(409, 'هذا الخادم مضاف مسبقاً');
    const name = clean(b.name, 80) || info.name || 'متجر';
    const k = svc.newStoreKey();
    const store = new MktStore({
      name, slug: await svc.uniqueSlug(b.slug || name), baseUrl: info.baseUrl,
      logo: info.logo, phone: info.phone, whatsapp: info.whatsapp, address: info.address,
      keyHash: k.keyHash, keyHint: k.keyHint,
      ...(info.location ? { location: { type: 'Point', coordinates: [info.location.lng, info.location.lat] } } : {}),
    });
    applyBody(store, { ...b, name });
    if (b.slug) store.slug = await svc.uniqueSlug(b.slug);
    await store.save();
    let sync = null;
    try { sync = await svc.syncStore(store._id); } catch (e) { sync = { ok: false, error: e.message }; }
    const fresh = await MktStore.findById(store._id).lean();
    res.status(201).json({ success: true, store: adminStore(fresh), sync, storeKey: k.key });
  }));

  r.put('/stores/:id', wrap(async (req, res) => {
    const store = await MktStore.findById(req.params.id).select('+keyHash');
    if (!store) throw httpError(404, 'المتجر غير موجود');
    const b = req.body || {};
    if (b.baseUrl && remote.normalizeBaseUrl(b.baseUrl) !== store.baseUrl) {
      const info = await remote.probe(b.baseUrl);
      if (await MktStore.exists({ baseUrl: info.baseUrl, _id: { $ne: store._id } })) throw httpError(409, 'هذا الخادم مضاف لمتجر آخر');
      store.baseUrl = info.baseUrl;
    }
    if (b.slug && b.slug !== store.slug) store.slug = await svc.uniqueSlug(b.slug, store._id);
    applyBody(store, b);
    await store.save();
    res.json({ success: true, store: adminStore(store.toObject()) });
  }));

  r.delete('/stores/:id', wrap(async (req, res) => {
    const store = await MktStore.findById(req.params.id).select('+keyHash');
    if (!store) throw httpError(404, 'المتجر غير موجود');
    await MktProduct.deleteMany({ store: store._id });
    await store.deleteOne();
    res.json({ success: true });
  }));

  r.post('/stores/:id/sync', wrap(async (req, res) => {
    const result = await svc.syncStore(req.params.id);
    const fresh = await MktStore.findById(req.params.id).lean();
    res.json({ success: true, result, store: adminStore(fresh) });
  }));

  r.post('/stores/:id/key', wrap(async (req, res) => {
    const store = await MktStore.findById(req.params.id).select('+keyHash');
    if (!store) throw httpError(404, 'المتجر غير موجود');
    const k = svc.newStoreKey();
    store.keyHash = k.keyHash; store.keyHint = k.keyHint;
    await store.save();
    res.json({ success: true, storeKey: k.key, keyHint: k.keyHint });
  }));

  r.get('/stores/:id/products', wrap(async (req, res) => {
    const list = await MktProduct.find({ store: req.params.id }).sort({ categoryName: 1, order: 1 }).limit(2000).lean();
    res.json({ success: true, products: list.map((p) => svc.productView(p)) });
  }));

  r.get('/brq-stores', wrap(async (_req, res) => {
    let list = [];
    try { list = await require('../alburaq/models/Store').find().select('name phone active').sort({ name: 1 }).lean(); } catch (_) {}
    res.json({ success: true, stores: list.map((s) => ({ id: String(s._id), name: s.name, phone: s.phone, active: s.active })) });
  }));

  r.get('/orders', wrap(async (req, res) => {
    const filter = {};
    if (validId(req.query.store)) filter.store = req.query.store;
    const orders = await MktOrder.find(filter).sort({ createdAt: -1 }).limit(Math.min(300, Number(req.query.limit) || 100)).lean();
    await svc.refreshStatuses(orders.filter((o) => Date.now() - new Date(o.createdAt).getTime() < 24 * 3600 * 1000).slice(0, 40));
    res.json({ success: true, orders: orders.map((o) => ({ ...svc.orderView(o), customerName: o.customerName, phone: o.phone, brqError: o.brqError || '', brqTrip: o.brqTrip ? String(o.brqTrip) : null })) });
  }));

  r.get('/reviews', wrap(async (req, res) => {
    const filter = {};
    if (validId(req.query.store)) filter.store = req.query.store;
    const list = await MktReview.find(filter).sort({ createdAt: -1 }).limit(200).populate('store', 'name').populate('product', 'name').lean();
    res.json({ success: true, reviews: list.map((r2) => ({ ...svc.reviewView(r2), hidden: !!r2.hidden, store: r2.store ? r2.store.name : '', product: r2.product ? r2.product.name : '' })) });
  }));
  r.put('/reviews/:id', wrap(async (req, res) => {
    const rv = await MktReview.findById(req.params.id);
    if (!rv) throw httpError(404, 'التقييم غير موجود');
    if (req.body.hidden !== undefined) rv.hidden = !!req.body.hidden;
    await rv.save();
    await svc.recomputeRating(MktStore, rv.store, 'store');
    if (rv.product) await svc.recomputeRating(MktProduct, rv.product, 'product');
    res.json({ success: true });
  }));

  r.get('/threads', wrap(async (req, res) => {
    const filter = validId(req.query.store) ? { store: req.query.store } : {};
    const list = await MktThread.find(filter).sort({ lastAt: -1 }).limit(100).populate('store', 'name').lean();
    res.json({ success: true, threads: list.map(threadView) });
  }));
  r.get('/threads/:id/messages', wrap(async (req, res) => {
    const msgs = await MktMessage.find({ thread: req.params.id }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, messages: msgs.reverse().map(msgView) });
  }));
  r.post('/threads/:id/messages', wrap(async (req, res) => {
    const t = await MktThread.findById(req.params.id);
    if (!t) throw httpError(404, 'المحادثة غير موجودة');
    const text = clean(req.body && req.body.text);
    if (!text) throw httpError(400, 'اكتب رسالتك');
    const m = await MktMessage.create({ thread: t._id, from: 'buraq', byName: 'فريق براق', text });
    t.lastText = text.slice(0, 120); t.lastAt = new Date(); t.unreadCustomer = (t.unreadCustomer || 0) + 1;
    await t.save();
    res.status(201).json({ success: true, message: msgView(m) });
  }));

  return r;
}

function threadView(t) {
  return { id: String(t._id), store: t.store && t.store.name ? { id: String(t.store._id), name: t.store.name } : { id: String(t.store) }, customerName: t.customerName, phone: t.phone, lastText: t.lastText, lastAt: t.lastAt, unread: t.unreadStore || 0 };
}

/* ═══════════════════════════ بوابة المتجر (مفتاح المتجر) ═══════════════════════════ */
function portalRouter() {
  const r = express.Router();
  r.use(limiter(120), wrap(async (req, _res, next) => {
    const store = await svc.storeByKey(req.headers['x-store-key']);
    if (!store) throw httpError(401, 'مفتاح المتجر غير صحيح');
    req.mktStore = store;
    next();
  }));

  r.get('/me', wrap(async (req, res) => {
    const s = req.mktStore;
    const unread = await MktThread.aggregate([{ $match: { store: s._id } }, { $group: { _id: null, n: { $sum: '$unreadStore' } } }]);
    res.json({ success: true, store: { ...svc.storeView(s.toObject(), null), sync: s.sync }, unread: unread[0] ? unread[0].n : 0 });
  }));
  r.post('/sync', limiter(6), wrap(async (req, res) => {
    const result = await svc.syncStore(req.mktStore._id);
    res.json({ success: true, result });
  }));
  r.get('/threads', wrap(async (req, res) => {
    const list = await MktThread.find({ store: req.mktStore._id }).sort({ lastAt: -1 }).limit(100).lean();
    res.json({ success: true, threads: list.map(threadView) });
  }));
  async function ownThread(req) {
    if (!validId(req.params.id)) throw httpError(400, 'معرّف غير صالح');
    const t = await MktThread.findOne({ _id: req.params.id, store: req.mktStore._id });
    if (!t) throw httpError(404, 'المحادثة غير موجودة');
    return t;
  }
  r.get('/threads/:id/messages', wrap(async (req, res) => {
    const t = await ownThread(req);
    const filter = { thread: t._id };
    if (req.query.after) { const d = new Date(req.query.after); if (!isNaN(d)) filter.createdAt = { $gt: d }; }
    const msgs = await MktMessage.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    if (t.unreadStore) { t.unreadStore = 0; await t.save(); }
    res.json({ success: true, messages: msgs.reverse().map(msgView) });
  }));
  r.post('/threads/:id/messages', limiter(60), wrap(async (req, res) => {
    const t = await ownThread(req);
    const text = clean(req.body && req.body.text);
    if (!text) throw httpError(400, 'اكتب رسالتك');
    const m = await MktMessage.create({ thread: t._id, from: 'store', byName: req.mktStore.name, text });
    t.lastText = text.slice(0, 120); t.lastAt = new Date(); t.unreadCustomer = (t.unreadCustomer || 0) + 1;
    await t.save();
    res.status(201).json({ success: true, message: msgView(m) });
  }));
  r.get('/reviews', wrap(async (req, res) => {
    const list = await MktReview.find({ store: req.mktStore._id, hidden: { $ne: true } }).sort({ createdAt: -1 }).limit(200).populate('product', 'name').lean();
    res.json({ success: true, reviews: list.map((x) => ({ ...svc.reviewView(x), product: x.product ? x.product.name : '' })) });
  }));
  r.post('/reviews/:id/reply', limiter(30), wrap(async (req, res) => {
    const rv = await MktReview.findOne({ _id: req.params.id, store: req.mktStore._id });
    if (!rv) throw httpError(404, 'التقييم غير موجود');
    rv.reply = clean(req.body && req.body.text, 500); rv.replyAt = rv.reply ? new Date() : null;
    await rv.save();
    res.json({ success: true, review: svc.reviewView(rv) });
  }));
  r.get('/orders', wrap(async (req, res) => {
    const orders = await MktOrder.find({ store: req.mktStore._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, orders: orders.map((o) => ({ ...svc.orderView(o), customerName: o.customerName, phone: o.phone })) });
  }));
  return r;
}

function router() {
  const r = express.Router();
  r.use('/admin', adminRouter());
  r.use('/portal', portalRouter());
  r.use('/', publicRouter());
  r.use((_req, res) => res.status(404).json({ success: false, message: 'المسار غير موجود' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'طلب غير صالح' });
    if (err.name === 'CastError' || err.name === 'BSONError') return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'السجل موجود مسبقاً' });
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: Object.values(err.errors || {}).map((e) => e.message).join('، ') || 'بيانات غير صالحة' });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500 && !err.remote) console.error('منصة براق — خطأ:', err);
    res.status(status).json({ success: false, message: status === 500 ? 'خطأ في الخادم' : err.message, ...(err.code && typeof err.code === 'string' ? { code: err.code } : {}) });
  });
  return r;
}

module.exports = { router, start: svc.start };
