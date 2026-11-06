/**
 * منصة براق — المنطق: المزامنة، التسعير، الطلبات، التقييمات.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { MktStore, MktProduct, MktOrder, MktReview } = require('./models');
const remote = require('./remote');

const { httpError } = remote;
const SYNC_EVERY_MIN = Math.max(2, Number(process.env.MKT_SYNC_MINUTES || 10));
const STALE_MS = Math.max(30, Number(process.env.MKT_STALE_SECONDS || 120)) * 1000; // فتح متجر بعد هذه المدة يحدّث منتجاته بالخلفية
const DONE = ['delivered'];
const CANCELLED = ['cancelled'];

const round3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const isPoint = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && Math.abs(+p.lat) <= 90 && Math.abs(+p.lng) <= 180 && !(+p.lat === 0 && +p.lng === 0);

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const storePoint = (s) => (s && s.location && Array.isArray(s.location.coordinates) && s.location.coordinates.length === 2
  ? { lat: s.location.coordinates[1], lng: s.location.coordinates[0] } : null);

function slugify(name) {
  const base = String(name || '').trim().toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base || `store-${crypto.randomBytes(3).toString('hex')}`;
}
async function uniqueSlug(wanted, exceptId) {
  const base = slugify(wanted);
  let slug = base;
  for (let i = 2; i < 200; i++) {
    const hit = await MktStore.findOne({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('_id').lean();
    if (!hit) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/* ═════════════ مفتاح بوابة المتجر ═════════════ */
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
function newStoreKey() {
  const key = `brq_${crypto.randomBytes(18).toString('base64url')}`;
  return { key, keyHash: hashKey(key), keyHint: `${key.slice(0, 8)}…${key.slice(-4)}` };
}
async function storeByKey(key) {
  if (!key || String(key).length < 16) return null;
  return MktStore.findOne({ keyHash: hashKey(key) }).select('+keyHash');
}

/* ═════════════ المزامنة ═════════════ */
const syncing = new Map(); // storeId → Promise (لا مزامنتان متزامنتان لنفس المتجر)

function syncStore(storeOrId) {
  const id = String(storeOrId && storeOrId._id ? storeOrId._id : storeOrId);
  if (syncing.has(id)) return syncing.get(id);
  const p = doSync(id).finally(() => syncing.delete(id));
  syncing.set(id, p);
  return p;
}

async function doSync(id) {
  const store = await MktStore.findById(id).select('+keyHash'); // الحفظ لا يمس المفتاح
  if (!store) throw httpError(404, 'المتجر غير موجود');
  const t0 = Date.now();
  try {
    const cat = await remote.fetchCatalog(store.baseUrl);
    const base = store.baseUrl;
    const visibleCats = cat.categories.filter((c) => c && c.isVisible !== false);
    const catById = new Map(visibleCats.map((c) => [String(c._id), c]));
    const now = new Date();
    const ops = [];
    const keep = [];
    for (const p of cat.products) {
      if (!p || !p._id) continue;
      const catId = p.category && typeof p.category === 'object' ? String(p.category._id || '') : String(p.category || '');
      if (catId && !catById.has(catId) && cat.categories.some((c) => String(c._id) === catId)) continue; // تصنيف مخفي
      const c = catById.get(catId);
      keep.push(String(p._id));
      ops.push({
        updateOne: {
          filter: { store: store._id, remoteId: String(p._id) },
          update: {
            $set: {
              name: p.nameAr || p.name || '',
              nameEn: p.nameEn || '',
              description: String(p.description || '').slice(0, 600),
              price: Number(p.price) || 0,
              oldPrice: p.oldPrice != null ? Number(p.oldPrice) : null,
              image: remote.absUrl(base, p.image || (Array.isArray(p.images) && p.images[0]) || ''),
              images: (Array.isArray(p.images) ? p.images : []).slice(0, 6).map((u) => remote.absUrl(base, u)),
              categoryId: catId,
              categoryName: c ? c.nameAr || '' : (p.category && p.category.nameAr) || '',
              addons: (Array.isArray(p.addons) ? p.addons : []).filter((a) => a && a.name).map((a) => ({ name: String(a.name), price: Number(a.price) || 0 })),
              available: p.isAvailable !== false && !(typeof p.stock === 'number' && p.stock <= 0),
              order: Number(p.order) || 0,
              popularity: Number(p.ordersCount) || 0,
              syncedAt: now,
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) await MktProduct.bulkWrite(ops, { ordered: false });
    // ما حُذف من خادم المتجر يُحذف من المنصة (التقييمات تبقى مرتبطة بالمتجر)
    await MktProduct.deleteMany({ store: store._id, remoteId: { $nin: keep } });

    const s = cat.settings || {};
    const d = cat.delivery || {};
    const st = s.restaurantStatus || {};
    let mode = st.mode || 'open';
    if (mode === 'busy' && st.busyUntil && Date.now() > new Date(st.busyUntil).getTime()) mode = 'open';
    store.remote = {
      restaurantName: s.restaurantName || '',
      status: mode,
      statusMessage: st.message || '',
      deliveryEnabled: d.enabled !== false && (s.delivery ? s.delivery.enabled !== false : true),
      maxDistanceKm: d.maxDistanceKm != null ? Number(d.maxDistanceKm) : null,
      workHoursNote: s.workHoursNote || '',
      categories: visibleCats.map((c) => ({ id: String(c._id), name: c.nameAr || '', nameEn: c.nameEn || '', image: remote.absUrl(base, c.image), order: Number(c.order) || 0 })),
    };
    if (!store.logo && s.logo) store.logo = remote.absUrl(base, s.logo);
    if (!storePoint(store) && d.restaurantLatitude != null && d.restaurantLongitude != null) {
      store.location = { type: 'Point', coordinates: [Number(d.restaurantLongitude), Number(d.restaurantLatitude)] };
    }
    store.sync = { at: now, ok: true, error: '', ms: Date.now() - t0, products: keep.length, categories: visibleCats.length };
    await store.save();
    return { ok: true, products: keep.length, categories: visibleCats.length, ms: Date.now() - t0 };
  } catch (e) {
    store.sync = { ...(store.sync && store.sync.toObject ? store.sync.toObject() : store.sync || {}), at: new Date(), ok: false, error: String(e.message || e).slice(0, 200), ms: Date.now() - t0 };
    await store.save().catch(() => {});
    throw e;
  }
}

/** متجر لم يُحدَّث منذ مدة: تحديث بالخلفية بلا انتظار (يظهر المنتج الجديد خلال دقيقتين من فتح المتجر). */
function refreshIfStale(store) {
  const at = store && store.sync && store.sync.at ? new Date(store.sync.at).getTime() : 0;
  if (Date.now() - at > STALE_MS) syncStore(store._id).catch(() => {});
}

let timer = null;
function start() {
  if (timer || process.env.MKT_SYNC_DISABLED === '1') return;
  const tick = async () => {
    if (mongoose.connection.readyState !== 1) return;
    const stores = await MktStore.find({ active: true }).select('_id').lean().catch(() => []);
    for (const s of stores) {
      await syncStore(s._id).catch((e) => console.warn(`منصة براق — مزامنة ${s._id}: ${e.message}`));
    }
  };
  setTimeout(() => tick().catch(() => {}), 20 * 1000).unref();
  timer = setInterval(() => tick().catch(() => {}), SYNC_EVERY_MIN * 60 * 1000);
  timer.unref();
}

/* ═════════════ العرض ═════════════ */
const avg = (r) => (r && r.count ? Math.round((r.sum / r.count) * 10) / 10 : 0);

function storeView(s, from) {
  const pt = storePoint(s);
  const km = from && pt ? Math.round(haversineKm(from, pt) * 10) / 10 : null;
  const d = s.delivery || {};
  const r = s.remote || {};
  const maxKm = r.maxDistanceKm;
  const storeDelivers = !!d.storeDrivers && r.deliveryEnabled !== false && (km == null || maxKm == null || km <= maxKm);
  const buraqDelivers = !!d.buraqDrivers && (km == null || !d.buraqMaxKm || d.buraqMode !== 'custom' || km <= d.buraqMaxKm);
  return {
    id: String(s._id), slug: s.slug, name: s.name, kind: s.kind, tags: s.tags || [],
    logo: s.logo || '', cover: s.cover || '', description: s.description || '', address: s.address || '',
    phone: s.phone || '', whatsapp: s.whatsapp || '',
    location: pt, distanceKm: km, featured: !!s.featured,
    status: r.status || 'open', statusMessage: r.statusMessage || '', workHoursNote: r.workHoursNote || '',
    rating: avg(s.rating), ratingCount: (s.rating && s.rating.count) || 0,
    products: (s.sync && s.sync.products) || 0,
    delivery: { store: storeDelivers, buraq: buraqDelivers, pickup: d.pickup !== false },
  };
}

function productView(p, store) {
  return {
    id: String(p._id), remoteId: p.remoteId, name: p.name, nameEn: p.nameEn, description: p.description,
    price: p.price, oldPrice: p.oldPrice, image: p.image, images: p.images || [],
    categoryId: p.categoryId, categoryName: p.categoryName, addons: p.addons || [], available: p.available !== false,
    rating: avg(p.rating), ratingCount: (p.rating && p.rating.count) || 0,
    store: store ? { id: String(store._id), slug: store.slug, name: store.name, logo: store.logo || '' } : undefined,
  };
}

/* ═════════════ تسعير التوصيل ═════════════ */
async function buraqSettings() {
  try { return await require('../alburaq/settings').getSettings(); } catch (_) { return { meterFlagFils: 76, perKmFils: 18 }; }
}

/** تسعيرة التوصيل للزبون. by: store (من خادم المتجر) | buraq (من إعدادات البراق) */
async function quote(store, { by, lat, lng, itemsTotal }) {
  const to = { lat: Number(lat), lng: Number(lng) };
  if (!isPoint(to)) throw httpError(400, 'حدّد موقع التوصيل على الخريطة');
  const d = store.delivery || {};
  if (by === 'buraq') {
    if (!d.buraqDrivers) throw httpError(400, 'توصيل البراق غير متاح لهذا المتجر');
    const from = storePoint(store);
    if (!from) throw httpError(400, 'موقع المتجر غير مسجّل');
    const km = Math.round(haversineKm(from, to) * 100) / 100;
    if (d.buraqMode === 'custom') {
      if (d.buraqMaxKm && km > d.buraqMaxKm) throw httpError(400, `الموقع خارج نطاق توصيل البراق (${d.buraqMaxKm} كم)`, { code: 'OUT_OF_RANGE' });
      return { ok: true, by, km, fee: round3(((d.buraqBaseFils || 0) + Math.round(km * (d.buraqPerKmFils || 0))) / 100) }; // بالقرش كتسعيرة البراق
    }
    const s = await buraqSettings();
    // تسعيرة البراق بالقرش (الدينار = 100 قرش)
    const fils = (s.meterFlagFils || 0) + Math.round(km * (s.perKmFils || 0));
    return { ok: true, by, km, fee: round3(fils / 100) };
  }
  if (!d.storeDrivers) throw httpError(400, 'هذا المتجر لا يوصّل بسائقيه');
  const r = await remote.call(store.baseUrl, '/api/settings/delivery-quote', { method: 'POST', body: { latitude: to.lat, longitude: to.lng, itemsTotal: Number(itemsTotal) || 0 } });
  const q = r.data || {};
  if (q.success === false) throw httpError(400, q.message || 'تعذّر حساب التوصيل', { code: q.code });
  const fee = q.fee != null ? Number(q.fee) : q.deliveryFee != null ? Number(q.deliveryFee) : 0;
  return { ok: true, by: 'store', km: q.distanceKm != null ? Number(q.distanceKm) : null, fee: round3(fee) };
}

/* ═════════════ الطلبات ═════════════ */
const normalizeLocalPhone = (intl) => (String(intl || '').startsWith('+962') ? `0${String(intl).slice(4)}` : String(intl || ''));

async function placeOrder(phoneUser, body) {
  const store = await MktStore.findById(body.storeId);
  if (!store || !store.active) throw httpError(404, 'المتجر غير متاح');
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 60);
  if (!items.length) throw httpError(400, 'السلة فارغة');
  const name = String(body.customerName || '').trim().slice(0, 60);
  if (name.length < 2) throw httpError(400, 'اكتب اسمك');
  const phone = normalizeLocalPhone(phoneUser.phone);
  const orderType = body.orderType === 'pickup' ? 'pickup' : 'delivery';
  const by = orderType === 'pickup' ? '' : body.deliveryBy === 'buraq' ? 'buraq' : 'store';
  const d = store.delivery || {};
  if (orderType === 'pickup' && d.pickup === false) throw httpError(400, 'الاستلام غير متاح لهذا المتجر');
  if (by === 'store' && !d.storeDrivers) throw httpError(400, 'هذا المتجر لا يوصّل بسائقيه — اختر توصيل البراق أو الاستلام');
  if (by === 'buraq' && !d.buraqDrivers) throw httpError(400, 'توصيل البراق غير متاح لهذا المتجر');
  const lat = Number(body.lat); const lng = Number(body.lng);
  const hasLoc = isPoint({ lat, lng });
  if (orderType === 'delivery' && !hasLoc) throw httpError(400, 'حدّد موقع التوصيل على الخريطة');

  // الأصناف من النسخة المخبأة للتحقق، والسعر النهائي من خادم المتجر
  const ids = items.map((i) => i.productId).filter((x) => mongoose.Types.ObjectId.isValid(x));
  const prods = await MktProduct.find({ _id: { $in: ids }, store: store._id }).lean();
  const byId = new Map(prods.map((p) => [String(p._id), p]));
  const lines = [];
  for (const it of items) {
    const p = byId.get(String(it.productId));
    if (!p) throw httpError(409, 'أحد الأصناف لم يعد موجوداً — حدّث السلة');
    const qty = Math.max(1, Math.min(99, parseInt(it.quantity, 10) || 1));
    const known = new Set((p.addons || []).map((a) => a.name));
    const addons = (Array.isArray(it.addons) ? it.addons : []).map((a) => String((a && a.name) || a || '')).filter((n) => known.has(n)).map((name) => ({ name }));
    lines.push({ product: p.remoteId, nameAr: p.name, quantity: qty, price: p.price, addons, notes: String(it.notes || '').slice(0, 200), _p: p });
  }

  // توصيل البراق: الطلب يصل المتجر «استلام» (السائق يستلمه)، والأجرة من تسعيرة البراق
  let buraqFee = 0;
  if (by === 'buraq') buraqFee = (await quote(store, { by: 'buraq', lat, lng })).fee;

  const clientRef = String(body.clientRef || '').slice(0, 64) || `mkt-${crypto.randomBytes(8).toString('hex')}`;
  const dup = await MktOrder.findOne({ clientRef, phoneUser: phoneUser._id }).lean();
  if (dup) return { order: dup, duplicate: true };

  const address = String(body.address || '').trim().slice(0, 200);
  const notesParts = [];
  notesParts.push('📱 طلب من تطبيق براق');
  if (by === 'buraq') notesParts.push(`🛵 توصيل شركة البراق — الأجرة ${buraqFee.toFixed(2)} د.أ يدفعها الزبون للسائق${address ? ` — العنوان: ${address}` : ''}${hasLoc ? ` — الموقع: https://maps.google.com/?q=${lat},${lng}` : ''}`);
  if (body.notes) notesParts.push(String(body.notes).slice(0, 300));

  const payload = {
    customerName: name,
    phone,
    address,
    orderType: by === 'buraq' ? 'pickup' : orderType,
    notes: notesParts.join(' | '),
    items: lines.map(({ _p, ...l }) => l),
    itemsTotal: round3(lines.reduce((s, l) => s + l.price * l.quantity, 0)),
    total: 1, // الخادم يعيد الحساب — الحقل مطلوب فقط
    deliveryFee: 0,
    clientRef,
    ...(orderType === 'delivery' && by === 'store' ? { customerLatitude: lat, customerLongitude: lng } : {}),
  };
  const r = await remote.call(store.baseUrl, '/api/orders', { method: 'POST', body: payload, timeout: 20000 });
  if (!r.ok || !r.data.success) {
    throw httpError(r.status >= 400 && r.status < 500 ? r.status : 502, r.data.message || 'تعذّر إرسال الطلب للمتجر', { code: r.data.code });
  }
  const ro = r.data.order || {};
  const itemsTotal = Number(ro.itemsTotal ?? payload.itemsTotal);
  const storeFee = Number(ro.deliveryFee || 0);
  const order = await MktOrder.create({
    store: store._id, storeName: store.name, phoneUser: phoneUser._id, customerName: name, phone,
    orderType, deliveryBy: by, address, lat: hasLoc ? lat : null, lng: hasLoc ? lng : null,
    items: (ro.items && ro.items.length ? ro.items : lines).map((i) => ({
      remoteId: String(i.product || ''), name: i.nameAr || i.name || '', quantity: i.quantity || 1, price: Number(i.price || 0),
      addons: (i.addons || []).map((a) => ({ name: a.name || '', price: Number(a.price || 0) })),
    })),
    itemsTotal: round3(itemsTotal),
    deliveryFee: round3(by === 'buraq' ? buraqFee : storeFee),
    total: round3(itemsTotal + (by === 'buraq' ? buraqFee : storeFee)),
    remoteId: String(r.data.orderId || ro._id || ''),
    orderNumber: String(r.data.orderNumber || ro.orderNumber || ''),
    trackingToken: String(r.data.trackingToken || ''),
    status: ro.status || 'pending',
    statusAt: new Date(),
    clientRef,
  });
  await MktStore.updateOne({ _id: store._id }, { $inc: { ordersCount: 1 } });

  if (by === 'buraq') {
    try {
      if (!d.brqStore) throw new Error('المتجر غير مربوط بمتجر في شركة البراق — اطلب السائق يدوياً');
      const BrqStore = require('../alburaq/models/Store');
      const bs = await BrqStore.findById(d.brqStore);
      if (!bs || !bs.active) throw new Error('متجر البراق المرتبط غير فعّال');
      const { createTripForStore } = require('../alburaq/services/dispatchService');
      const trip = await createTripForStore(bs, {
        customerPhone: phone, customerName: name, customerLat: lat, customerLng: lng, customerLocationSource: 'map',
        stops: [{ phone, name, lat, lng, source: 'map', note: `تطبيق براق — طلب #${order.orderNumber}${address ? ` — ${address}` : ''}`.slice(0, 200) }],
      }, { kind: 'store', channel: 'app', orderNumber: String(order.orderNumber || ''), by: 'تطبيق براق' });
      order.brqTrip = trip._id;
    } catch (e) {
      order.brqError = String(e.message || e).slice(0, 200);
      console.warn(`منصة براق — رحلة البراق للطلب ${order._id}: ${order.brqError}`);
    }
    await order.save();
  }
  return { order: order.toObject() };
}

/** تحديث حالات طلبات زبون من خوادم المتاجر (دفعة واحدة لكل متجر). */
async function refreshStatuses(orders) {
  const open = orders.filter((o) => o.remoteId && !DONE.includes(o.status) && !CANCELLED.includes(o.status));
  if (!open.length) return orders;
  const withTok = await MktOrder.find({ _id: { $in: open.map((o) => o._id) } }).select('+trackingToken store remoteId').lean();
  const byStore = new Map();
  for (const o of withTok) {
    if (!o.trackingToken) continue;
    const k = String(o.store);
    if (!byStore.has(k)) byStore.set(k, []);
    byStore.get(k).push(o);
  }
  const stores = await MktStore.find({ _id: { $in: [...byStore.keys()] } }).select('baseUrl').lean();
  const updates = new Map();
  await Promise.all(stores.map(async (s) => {
    const list = byStore.get(String(s._id)) || [];
    try {
      const r = await remote.call(s.baseUrl, '/api/orders/track', { method: 'POST', body: { refs: list.map((o) => ({ id: o.remoteId, token: o.trackingToken })) }, timeout: 8000 });
      for (const ro of remote.listOf(r.data)) {
        const mine = list.find((o) => o.remoteId === String(ro.id));
        if (mine) updates.set(String(mine._id), { status: ro.status, statusLabel: ro.deliveryState || '' });
      }
    } catch (_) { /* خادم المتجر غير متاح الآن — نعرض آخر حالة معروفة */ }
  }));
  const ops = [];
  for (const o of orders) {
    const u = updates.get(String(o._id));
    if (u && (u.status !== o.status || u.statusLabel !== o.statusLabel)) {
      o.status = u.status; o.statusLabel = u.statusLabel; o.statusAt = new Date();
      ops.push({ updateOne: { filter: { _id: o._id }, update: { $set: { status: u.status, statusLabel: u.statusLabel, statusAt: o.statusAt } } } });
    }
  }
  if (ops.length) await MktOrder.bulkWrite(ops).catch(() => {});
  return orders;
}

const STATUS_AR = {
  pending: 'بانتظار تأكيد المتجر', new: 'تم التأكيد', preparing: 'قيد التحضير', ready: 'جاهز',
  out_for_delivery: 'في الطريق إليك', delivered: 'تم التسليم', cancelled: 'ملغى',
};

function orderView(o, store) {
  const canReview = !o.reviewed && (DONE.includes(o.status) || (o.status === 'ready' && o.orderType === 'pickup'));
  return {
    id: String(o._id), store: store ? { id: String(store._id), slug: store.slug, name: store.name, logo: store.logo || '' } : { id: String(o.store), name: o.storeName },
    orderNumber: o.orderNumber, orderType: o.orderType, deliveryBy: o.deliveryBy,
    items: o.items, itemsTotal: o.itemsTotal, deliveryFee: o.deliveryFee, total: o.total,
    status: o.status, statusText: STATUS_AR[o.status] || o.status, createdAt: o.createdAt, address: o.address,
    canReview, reviewed: !!o.reviewed,
  };
}

/* ═════════════ التقييمات ═════════════ */
async function recomputeRating(Model, id, field) {
  const [agg] = await MktReview.aggregate([
    { $match: { [field]: new mongoose.Types.ObjectId(String(id)), hidden: { $ne: true }, ...(field === 'store' ? { product: null } : {}) } },
    { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: '$stars' } } },
  ]);
  await Model.updateOne({ _id: id }, { $set: { rating: { count: agg ? agg.count : 0, sum: agg ? agg.sum : 0 } } });
}

/**
 * تقييم بعد الطلب: { orderId, store: { stars, text }, products: [{ productId, stars, text }] }
 * تقييم واحد للمتجر ولكل منتج في الطلب — بعد التسليم (أو جاهزية طلب الاستلام).
 */
async function submitReview(phoneUser, body, authorName) {
  const order = await MktOrder.findOne({ _id: body.orderId, phoneUser: phoneUser._id });
  if (!order) throw httpError(404, 'الطلب غير موجود');
  await refreshStatuses([order]);
  const allowed = DONE.includes(order.status) || (order.orderType === 'pickup' && order.status === 'ready');
  if (!allowed) throw httpError(409, 'تستطيع التقييم بعد استلام طلبك');
  if (order.reviewed) throw httpError(409, 'قيّمت هذا الطلب مسبقاً');
  const clean = (t) => String(t || '').replace(/<[^>]*>/g, '').trim().slice(0, 500);
  const stars = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 0)));
  const docs = [];
  if (body.store && body.store.stars) {
    docs.push({ store: order.store, product: null, order: order._id, phoneUser: phoneUser._id, authorName, stars: stars(body.store.stars), text: clean(body.store.text) });
  }
  const remoteIds = new Set(order.items.map((i) => i.remoteId));
  const touched = [];
  for (const pr of (Array.isArray(body.products) ? body.products : []).slice(0, 30)) {
    if (!pr || !pr.stars) continue;
    // بمعرّف المنتج في المنصة أو بمعرّفه على خادم المتجر (كما في بنود الطلب)
    const byOwn = mongoose.Types.ObjectId.isValid(pr.productId);
    if (!byOwn && !pr.remoteId) continue;
    const p = await MktProduct.findOne(byOwn ? { _id: pr.productId, store: order.store } : { remoteId: String(pr.remoteId), store: order.store }).select('remoteId').lean();
    if (!p || !remoteIds.has(p.remoteId)) continue;
    docs.push({ store: order.store, product: p._id, order: order._id, phoneUser: phoneUser._id, authorName, stars: stars(pr.stars), text: clean(pr.text) });
    touched.push(p._id);
  }
  if (!docs.length) throw httpError(400, 'اختر عدد النجوم');
  await MktReview.insertMany(docs, { ordered: false }).catch((e) => { if (!(e && (e.code === 11000 || (e.writeErrors || []).every((w) => w.code === 11000)))) throw e; });
  order.reviewed = true;
  await order.save();
  await recomputeRating(MktStore, order.store, 'store');
  for (const id of touched) await recomputeRating(MktProduct, id, 'product');
  return { ok: true, count: docs.length };
}

function reviewView(r) {
  return { id: String(r._id), author: r.authorName || 'زبون', stars: r.stars, text: r.text || '', reply: r.reply || '', replyAt: r.replyAt, createdAt: r.createdAt };
}

module.exports = {
  SYNC_EVERY_MIN, slugify, uniqueSlug, newStoreKey, storeByKey, syncStore, refreshIfStale, start,
  storeView, productView, storePoint, haversineKm, isPoint, quote, placeOrder, refreshStatuses, orderView,
  submitReview, recomputeRating, reviewView, STATUS_AR,
};
