const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const cfg = require('../config');
const Driver = require('../models/Driver');
const Store = require('../models/Store');
const Area = require('../models/Area');
const Trip = require('../models/Trip');
const Rating = require('../models/Rating');
const User = require('../../models/User');
const Settlement = require('../models/Settlement');
const { normalizePhone, isValidPin, generateOtp, hashSecret } = require('../security');
const { requireStaff, can, PERM } = require('../auth');
const { publicDriver } = require('../publicDriver');
const { publicTrip } = require('../publicTrip');
const { getSettings, updateSettings } = require('../settings');
const { isValidPoint } = require('../geo');
const realtime = require('../realtime');
const dispatch = require('../services/dispatchService');

const router = express.Router();

const publicStore = (s) => ({
  id: String(s._id), name: s.name, phone: s.phone, active: s.active,
  location: s.location ? { lat: s.location.lat, lng: s.location.lng } : null,
});
const publicArea = (a) => ({ id: String(a._id), name: a.name, center: a.center, active: a.active });

const fail = (res, e) => res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => fail(res, e));

/*
 * /api/brq/admin — بنفس مستخدمي ديار (/api/auth/login)، وكل مسار بصلاحية من كتالوج ديار:
 *   brq:manage   الخريطة، السائقون، المتاجر، المناطق، الطلبات
 *   brq:ledger   الجرد والتحصيل وسندات القبض
 *   brq:settings التسعير وربط متجر المطعم
 *   brq:prints   كشوف الأسعار، التصاريح، الوصولات (والجرد يطبع سنداته بصلاحيته)
 */
router.use(requireStaff(PERM.manage, PERM.ledger, PERM.settings, PERM.prints));
router.use((req, res, next) => {
  const path = req.path;
  let need = [PERM.manage];
  if (path.startsWith('/ledger')) need = [PERM.ledger];
  else if (/^\/print\/(payment|driver-statement|store-statement)/.test(path)) need = [PERM.ledger, PERM.prints];
  else if (path.startsWith('/print/')) need = [PERM.prints];
  else if (path === '/settings' || path === '/restaurant-store') need = req.method === 'GET' ? [PERM.manage, PERM.settings] : [PERM.settings];
  else if (req.method === 'GET' && ['/map', '/stores', '/drivers', '/areas'].includes(path)) need = [PERM.manage, PERM.ledger, PERM.prints, PERM.settings];
  return can(...need)(req, res, next);
});

/* ───── الجرد والتحصيل ───── */
const ledger = require('../services/ledgerService');
const docs = require('../receipts');
const printing = require('../services/printService');
const range = (q) => ({ from: q.from, to: q.to });

/** GET /api/brq/admin/ledger?from&to — كل السائقين: الفترة + المتبقي على كل منهم للشركة */
router.get('/ledger', wrap(async (req, res) => {
  res.json({ success: true, ...(await ledger.driversBalances(range(req.query))) });
}));

/** GET /api/brq/admin/ledger/drivers/:id?from&to — جرد سائق مع التوصيلات والدفعات */
router.get('/ledger/drivers/:id', wrap(async (req, res) => {
  const d = await Driver.findById(req.params.id).lean();
  if (!d) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  res.json({ success: true, driver: publicDriver(d), account: await ledger.driverAccount(d._id, range(req.query)) });
}));

async function addPayment(req, res, party) {
  const amountFils = Math.round(Number(req.body.amountFils));
  if (!Number.isFinite(amountFils) || amountFils === 0 || Math.abs(amountFils) > 10000000) {
    return res.status(400).json({ success: false, message: 'المبلغ بالقرش مطلوب' });
  }
  const Model = party === 'driver' ? Driver : Store;
  const p = await Model.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ success: false, message: party === 'driver' ? 'السائق غير موجود' : 'المتجر غير موجود' });
  const s = await Settlement.create({
    party, [party]: p._id, partyName: p.name, amountFils,
    note: String(req.body.note || '').trim().slice(0, 200),
    receiptNo: ledger.serial(party === 'driver' ? 'RD' : 'RS'),
    by: req.user._id, byName: req.user.name || req.user.username || '',
  });
  const balanceFils = party === 'driver' ? (await ledger.driverAccount(p._id)).balanceFils : null;
  res.status(201).json({ success: true, settlement: { id: String(s._id), receiptNo: s.receiptNo, amountFils: s.amountFils }, balanceFils });
}
/** POST /api/brq/admin/ledger/drivers/:id/payments  { amountFils, note } — السائق دفع حصة الشركة */
router.post('/ledger/drivers/:id/payments', wrap((req, res) => addPayment(req, res, 'driver')));
/** POST /api/brq/admin/ledger/stores/:id/payments  { amountFils, note } — المتجر دفع للشركة */
router.post('/ledger/stores/:id/payments', wrap((req, res) => addPayment(req, res, 'store')));

/** POST /api/brq/admin/ledger/payments/:id/void — إلغاء سند (لمن أخطأ في التسجيل) */
router.post('/ledger/payments/:id/void', wrap(async (req, res) => {
  const s = await Settlement.findOneAndUpdate({ _id: req.params.id, voided: false }, { $set: { voided: true } }, { new: true });
  if (!s) return res.status(404).json({ success: false, message: 'السند غير موجود' });
  res.json({ success: true });
}));

/** GET /api/brq/admin/ledger/stores?from&to — كل المتاجر */
router.get('/ledger/stores', wrap(async (req, res) => {
  res.json({ success: true, stores: await ledger.storesTotals(range(req.query)) });
}));
/** GET /api/brq/admin/ledger/stores/:id?from&to — كشف حساب متجر */
router.get('/ledger/stores/:id', wrap(async (req, res) => {
  const st = await Store.findById(req.params.id).lean();
  if (!st) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  res.json({ success: true, store: publicStore(st), account: await ledger.storeAccount(st._id, range(req.query)) });
}));

/* ───── الطباعة: الورقة تُبنى هنا؛ الواجهة تطبعها محلياً (DiyarPOS) أو { remote: true } لجهاز الكاشير ───── */

/** POST /api/brq/admin/print/price-sheet/:storeId  { format: 'a4'|'thermal', remote? } — بالشعار والختم المعتمد */
router.post('/print/price-sheet/:storeId', wrap(async (req, res) => {
  const { priceSheetForStore } = require('../services/priceSheet');
  const st = await Store.findById(req.params.storeId).lean();
  if (!st) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  const [sheet, settings] = await Promise.all([priceSheetForStore(st), getSettings()]);
  const args = { brand: cfg.brand, logoUrl: docs.logoDataUri(), storeName: st.name, storePhone: st.phone, storeLocation: st.location, sheet, settings };
  const html = req.body.format === 'thermal' ? docs.priceSheetHtml(args) : docs.priceSheetA4Html(args);
  await printing.respond(req, res, { title: `كشف أسعار ${st.name}`, html });
}));

/** POST /api/brq/admin/print/permit/:driverId  { months? } — تصريح سائق (A4) — يُولَّد رقمه عند أول طباعة */
router.post('/print/permit/:driverId', wrap(async (req, res) => {
  let d = await Driver.findById(req.params.driverId);
  if (!d) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  const months = Math.max(1, Math.min(24, Number(req.body.months) || 12));
  const renew = !d.permitNo || req.body.renew || !d.permitExpiresAt || d.permitExpiresAt < new Date();
  if (renew) {
    const now = new Date();
    d.permitNo = d.permitNo || `BRQ-${now.getFullYear()}-${String(d._id).slice(-5).toUpperCase()}`;
    d.permitIssuedAt = now;
    d.permitExpiresAt = new Date(now.getTime() + months * 30 * 86400000);
    await d.save();
  }
  await printing.respond(req, res, { title: `تصريح ${d.name}`, html: docs.permitHtml({ brand: cfg.brand, driver: d.toObject() }) });
}));

/** POST /api/brq/admin/print/payment/:settlementId — سند قبض (حراري) */
router.post('/print/payment/:settlementId', wrap(async (req, res) => {
  const s = await Settlement.findById(req.params.settlementId).lean();
  if (!s) return res.status(404).json({ success: false, message: 'السند غير موجود' });
  const balanceAfterFils = s.party === 'driver' ? (await ledger.driverAccount(s.driver)).balanceFils : null;
  await printing.respond(req, res, { title: `سند قبض ${s.receiptNo}`, html: docs.paymentReceiptHtml({ brand: cfg.brand, s, balanceAfterFils }) });
}));

/** POST /api/brq/admin/print/trip/:tripId — وصل توصيل (حراري) بتفاصيل حصة الشركة */
router.post('/print/trip/:tripId', wrap(async (req, res) => {
  const t = await Trip.findById(req.params.tripId).lean();
  if (!t || t.status !== 'completed') return res.status(404).json({ success: false, message: 'التوصيلة غير مكتملة' });
  await printing.respond(req, res, { title: `وصل ${t.receiptNo || ''}`, html: docs.tripReceiptHtml({ brand: cfg.brand, t, viewer: 'admin' }) });
}));

/** POST /api/brq/admin/print/driver-statement/:driverId  { from, to } — كشف جرد سائق (حراري) */
router.post('/print/driver-statement/:driverId', wrap(async (req, res) => {
  const d = await Driver.findById(req.params.driverId).lean();
  if (!d) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  const l = await ledger.driverAccount(d._id, range(req.body));
  await printing.respond(req, res, { title: `جرد ${d.name}`, html: docs.driverStatementHtml({ brand: cfg.brand, driver: d, l, from: req.body.from, to: req.body.to }) });
}));

/** POST /api/brq/admin/print/store-statement/:storeId  { from, to } — كشف حساب متجر (A4) */
router.post('/print/store-statement/:storeId', wrap(async (req, res) => {
  const st = await Store.findById(req.params.storeId).lean();
  if (!st) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  const l = await ledger.storeAccount(st._id, range(req.body));
  await printing.respond(req, res, { title: `كشف ${st.name}`, html: docs.storeStatementHtml({ brand: cfg.brand, store: st, l, from: req.body.from, to: req.body.to }) });
}));

/** GET /api/brq/admin/map — لقطة كاملة للخريطة: السائقون، المتاجر، المناطق، والطلبات المفتوحة */
router.get('/map', wrap(async (_req, res) => {
  const now = Date.now();
  const [drivers, stores, areas, trips] = await Promise.all([
    Driver.find().sort({ name: 1 }).lean(),
    Store.find({ active: true }).lean(),
    Area.find().sort({ name: 1 }).lean(),
    Trip.find({ status: { $in: ['searching', 'assigned'] } }).lean(),
  ]);
  res.json({
    success: true,
    drivers: drivers.map((d) => publicDriver(d, now)),
    stores: stores.map(publicStore),
    areas: areas.map(publicArea),
    trips: trips.map((t) => publicTrip(t, 'admin')),
  });
}));

/** GET /api/brq/admin/drivers/:id — تفاصيل السائق عند الضغط عليه على الخريطة */
router.get('/drivers/:id', wrap(async (req, res) => {
  const d = await Driver.findById(req.params.id).lean();
  if (!d) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  const [openTrips, recent, ratings] = await Promise.all([
    d.currentTrips && d.currentTrips.length ? Trip.find({ _id: { $in: d.currentTrips } }).lean() : [],
    Trip.find({ driver: d._id }).sort({ requestedAt: -1 }).limit(10).lean(),
    Rating.aggregate([
      { $match: { driver: d._id } },
      { $lookup: { from: 'brq_stores', localField: 'store', foreignField: '_id', as: 's' } },
      { $project: { stars: 1, storeName: { $arrayElemAt: ['$s.name', 0] }, createdAt: 1 } },
      { $sort: { createdAt: -1 } },
      { $limit: 10 },
    ]),
  ]);
  res.json({
    success: true,
    driver: publicDriver(d),
    currentTrips: openTrips.map((t) => publicTrip(t, 'admin')),
    recentTrips: recent.map((t) => publicTrip(t, 'admin')),
    ratings: ratings.map((r) => ({ stars: r.stars, storeName: r.storeName || '', at: r.createdAt })),
  });
}));

router.get('/drivers', wrap(async (_req, res) => {
  const list = await Driver.find().sort({ name: 1 }).lean();
  const now = Date.now();
  res.json({ success: true, drivers: list.map((d) => publicDriver(d, now)) });
}));

const driverExtras = (b) => {
  const set = {};
  if (b.vehicle !== undefined) set.vehicle = String(b.vehicle || '').trim().slice(0, 60);
  if (b.plate !== undefined) set.plate = String(b.plate || '').trim().slice(0, 30);
  if (b.nationalId !== undefined) set.nationalId = String(b.nationalId || '').trim().slice(0, 30);
  return set;
};

/** POST /api/brq/admin/drivers  { name, phone, pin, vehicle?, plate?, nationalId? } */
router.post('/drivers', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  if (!name || !phone || !isValidPin(pin)) {
    return res.status(400).json({ success: false, message: 'الاسم ورقم الهاتف و PIN من 4 إلى 6 أرقام مطلوبة' });
  }
  if (await Driver.exists({ phone })) return res.status(409).json({ success: false, message: 'هذا الرقم مسجّل لسائق آخر' });
  const driver = await Driver.create({ name, phone, pinHash: await hashSecret(pin), ...driverExtras(req.body) });
  res.status(201).json({ success: true, driver: publicDriver(driver) });
}));

/** PATCH /api/brq/admin/drivers/:id  { name?, vehicle?, plate?, nationalId? } — بيانات التصريح */
router.patch('/drivers/:id', wrap(async (req, res) => {
  const set = driverExtras(req.body);
  if (req.body.name !== undefined) set.name = String(req.body.name || '').trim().slice(0, 80);
  if (set.name === '') return res.status(400).json({ success: false, message: 'الاسم مطلوب' });
  const driver = await Driver.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
  if (!driver) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  dispatch.publishDriver(driver);
  res.json({ success: true, driver: publicDriver(driver) });
}));

/** POST /api/brq/admin/drivers/:id/otp — يُعيد الرمز مرة واحدة فقط */
router.post('/drivers/:id/otp', wrap(async (req, res) => {
  const otp = generateOtp(12);
  const expiresAt = new Date(Date.now() + cfg.otpTtlDays * 24 * 60 * 60 * 1000);
  const driver = await Driver.findByIdAndUpdate(
    req.params.id,
    { $set: { otpHash: await hashSecret(otp), otpExpiresAt: expiresAt, failedAttempts: 0, lockedUntil: null } },
    { new: true }
  );
  if (!driver) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  res.json({ success: true, otp, expiresAt, driver: publicDriver(driver) });
}));

/** POST /api/brq/admin/drivers/:id/pin  { pin } — يُبطل الجلسات */
router.post('/drivers/:id/pin', wrap(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!isValidPin(pin)) return res.status(400).json({ success: false, message: 'PIN من 4 إلى 6 أرقام' });
  const driver = await Driver.findByIdAndUpdate(req.params.id, { $set: { pinHash: await hashSecret(pin) }, $inc: { tokenVersion: 1 } }, { new: true });
  if (!driver) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  dispatch.publishDriver(driver);
  res.json({ success: true, driver: publicDriver(driver) });
}));

/** POST /api/brq/admin/drivers/:id/active  { active } — التعطيل يُبطل الجلسات ويُلغي ما بيده */
router.post('/drivers/:id/active', wrap(async (req, res) => {
  const active = req.body.active === true;
  const update = { $set: { active } };
  if (!active) update.$inc = { tokenVersion: 1 };
  const driver = await Driver.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!driver) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
  dispatch.publishDriver(driver);
  res.json({ success: true, driver: publicDriver(driver) });
}));

router.get('/stores/:id/price-sheet', wrap(async (req, res) => {
  const { priceSheetForStore } = require('../services/priceSheet');
  const s = await Store.findById(req.params.id).lean();
  if (!s) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  res.json({ success: true, store: s.name, sheet: await priceSheetForStore(s) });
}));

router.get('/stores', wrap(async (_req, res) => {
  const stores = await Store.find().sort({ name: 1 }).lean();
  res.json({ success: true, stores: stores.map(publicStore) });
}));

/** POST /api/brq/admin/stores/:id/active  { active } */
router.post('/stores/:id/active', wrap(async (req, res) => {
  const s = await Store.findByIdAndUpdate(
    req.params.id,
    { $set: { active: req.body.active === true }, $inc: { tokenVersion: 1 } },
    { new: true }
  );
  if (!s) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  realtime.toAdmins({ type: 'store.updated', store: publicStore(s) });
  res.json({ success: true, store: publicStore(s) });
}));

/** PUT /api/brq/admin/stores/:id/location  { lat, lng } — تصحيح موقع المتجر (رابط مشاركة أو خريطة) */
router.put('/stores/:id/location', wrap(async (req, res) => {
  const location = { lat: Number(req.body.lat), lng: Number(req.body.lng), at: new Date() };
  if (!isValidPoint(location)) return res.status(400).json({ success: false, message: 'موقع غير صالح' });
  const s = await Store.findByIdAndUpdate(req.params.id, { $set: { location } }, { new: true });
  if (!s) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  realtime.toAdmins({ type: 'store.updated', store: publicStore(s) });
  res.json({ success: true, store: publicStore(s) });
}));

/* ───── المناطق ───── */

const parseArea = (b) => {
  const name = String(b.name || '').trim().slice(0, 60);
  const center = { lat: Number(b.lat), lng: Number(b.lng) };
  return { name, center };
};

router.get('/areas', wrap(async (_req, res) => {
  const areas = await Area.find().sort({ name: 1 }).lean();
  res.json({ success: true, areas: areas.map(publicArea) });
}));

router.post('/areas', wrap(async (req, res) => {
  const { name, center } = parseArea(req.body);
  if (!name || !isValidPoint(center)) return res.status(400).json({ success: false, message: 'اسم المنطقة ونقطة مركزها على الخريطة مطلوبان' });
  if (await Area.exists({ name })) return res.status(409).json({ success: false, message: 'اسم المنطقة موجود' });
  const area = await Area.create({ name, center });
  res.status(201).json({ success: true, area: publicArea(area) });
}));

router.patch('/areas/:id', wrap(async (req, res) => {
  const set = {};
  if (req.body.name !== undefined) set.name = String(req.body.name).trim().slice(0, 60);
  if (req.body.lat !== undefined || req.body.lng !== undefined) {
    const center = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
    if (!isValidPoint(center)) return res.status(400).json({ success: false, message: 'إحداثيات غير صالحة' });
    set.center = center;
  }
  if (req.body.active !== undefined) set.active = req.body.active === true;
  const area = await Area.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
  if (!area) return res.status(404).json({ success: false, message: 'المنطقة غير موجودة' });
  res.json({ success: true, area: publicArea(area) });
}));

/* ───── الإعدادات والتسعير ───── */

router.get('/settings', wrap(async (_req, res) => {
  const Settings = require('../models/Settings');
  const doc = await Settings.findOne({ key: 'main' }).select('restaurantStore').lean();
  res.json({ success: true, settings: await getSettings(), restaurantStoreId: doc && doc.restaurantStore ? String(doc.restaurantStore) : null });
}));

/** PUT /api/brq/admin/restaurant-store  { storeId|null } — متجر المطعم: «طلب سائق البراق» من حالة الطلبات يُرسل باسمه */
router.put('/restaurant-store', wrap(async (req, res) => {
  const Settings = require('../models/Settings');
  const id = req.body.storeId || null;
  if (id && !(await Store.exists({ _id: id }))) return res.status(404).json({ success: false, message: 'المتجر غير موجود' });
  await Settings.updateOne({ key: 'main' }, { $set: { restaurantStore: id } }, { upsert: true });
  res.json({ success: true, restaurantStoreId: id });
}));

router.put('/settings', wrap(async (req, res) => {
  const settings = await updateSettings(req.body || {});
  res.json({ success: true, settings });
}));

/* ───── الطلبات ───── */

router.get('/trips', wrap(async (req, res) => {
  const filter = req.query.active ? { status: { $in: ['searching', 'assigned'] } } : {};
  const trips = await Trip.find(filter).sort({ requestedAt: -1 }).limit(100).lean();
  res.json({ success: true, trips: trips.map((t) => publicTrip(t, 'admin')) });
}));

router.post('/trips/:id/cancel', wrap(async (req, res) => {
  const trip = await dispatch.cancelTrip(req.params.id, { admin: true });
  res.json({ success: true, trip: publicTrip(trip, 'admin') });
}));

/** POST /api/brq/admin/trips/:id/stops/:stopId/location  { lat, lng } */
router.post('/trips/:id/stops/:stopId/location', wrap(async (req, res) => {
  const trip = await dispatch.setStopLocation(req.params.id, req.params.stopId, { lat: Number(req.body.lat), lng: Number(req.body.lng) }, { admin: true });
  res.json({ success: true, trip: publicTrip(trip, 'admin') });
}));

/* ───── مندوبو ديار (حسابات role=delivery) → سائقون في شركة البراق ───── */

/** GET /api/brq/admin/delivery-reps — المندوبون المسجّلون في ديار، مع من أُضيف منهم كسائق */
router.get('/delivery-reps', wrap(async (_req, res) => {
  const reps = await User.find({ role: 'delivery' }).select('name phone isActive').sort({ name: 1 }).lean();
  // ديار يخزّن الرقم محلياً (07…)؛ السائق قد يُسجَّل به أو بالدولي (+9627…) — نطابق الصيغتين
  const forms = (p) => {
    const n = normalizePhone(p);
    if (!n) return [];
    if (/^07\d{8}$/.test(n)) return [n, '+962' + n.slice(1)];
    if (/^\+9627\d{8}$/.test(n)) return [n, '0' + n.slice(4)];
    return [n];
  };
  const all = reps.flatMap((r) => forms(r.phone));
  const existing = new Set((await Driver.find({ phone: { $in: all } }).select('phone').lean()).map((d) => d.phone));
  res.json({
    success: true,
    reps: reps.map((r) => ({
      id: String(r._id), name: r.name, phone: normalizePhone(r.phone) || r.phone || '',
      active: r.isActive !== false, isDriver: forms(r.phone).some((f) => existing.has(f)),
    })),
  });
}));

module.exports = router;
