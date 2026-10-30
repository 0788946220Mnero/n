const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Store = require('../models/Store');
const Area = require('../models/Area');
const Trip = require('../models/Trip');
const { signStoreToken, requireStore } = require('../auth');
const { normalizePhone, hashSecret, compareSecret } = require('../security');
const { nextFailureState, isLocked } = require('../loginPolicy');
const { isValidPoint } = require('../geo');
const { publicTrip } = require('../publicTrip');
const dispatch = require('../services/dispatchService');
const realtime = require('../realtime');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const limiter = (limit) => rateLimit({
  windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة، حاول بعد قليل' },
});

const publicStore = (s) => ({
  id: String(s._id), name: s.name, phone: s.phone, active: s.active,
  location: s.location ? { lat: s.location.lat, lng: s.location.lng } : null,
});

/** POST /api/brq/store/register  { name, phone, password, lat, lng } */
router.post('/register', limiter(10), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  const location = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
  if (!name || !phone || password.length < 6 || !isValidPoint(location)) {
    return res.status(400).json({ success: false, message: 'الاسم والرقم وكلمة مرور (6 أحرف+) وموقع المتجر على الخريطة مطلوبة' });
  }
  if (await Store.exists({ phone })) return res.status(409).json({ success: false, message: 'هذا الرقم مسجّل مسبقاً' });
  const store = await Store.create({ name, phone, passwordHash: await hashSecret(password), location: { ...location, at: new Date() } });
  realtime.toAdmins({ type: 'store.updated', store: publicStore(store) });
  res.status(201).json({ success: true, token: signStoreToken(store), store: publicStore(store) });
});

/** POST /api/brq/store/login  { phone, password } */
router.post('/login', limiter(20), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  const invalid = { success: false, message: 'بيانات الدخول غير صحيحة' };
  if (!phone || !password) return res.status(400).json({ success: false, message: 'الرقم وكلمة المرور مطلوبان' });

  const store = await Store.findOne({ phone });
  const now = Date.now();
  if (!store || !store.active) { await compareSecret(password, DUMMY_HASH); return res.status(401).json(invalid); }
  if (isLocked(store.lockedUntil, now)) return res.status(401).json(invalid);

  const ok = await compareSecret(password, store.passwordHash);
  if (!ok) {
    await Store.updateOne({ _id: store._id }, { $set: nextFailureState(store.failedAttempts, now) });
    return res.status(401).json(invalid);
  }
  await Store.updateOne({ _id: store._id }, { $set: { failedAttempts: 0, lockedUntil: null } });
  res.json({ success: true, token: signStoreToken(store), store: publicStore(store) });
});

router.get('/me', requireStore, (req, res) => res.json({ success: true, store: publicStore(req.store) }));

/** GET /api/brq/store/areas — المناطق المتاحة للاختيار */
router.get('/areas', requireStore, async (_req, res) => {
  const areas = await Area.find({ active: true }).sort({ name: 1 }).lean();
  res.json({ success: true, areas: areas.map((a) => ({ id: String(a._id), name: a.name })) });
});

/** GET /api/brq/store/price-sheet — تقدير السعر لكل منطقة من موقع متجرك */
router.get('/price-sheet', requireStore, async (req, res, next) => {
  try {
    const { priceSheetForStore } = require('../services/priceSheet');
    res.json({ success: true, sheet: await priceSheetForStore(req.store) });
  } catch (e) { next(e); }
});

/** GET /api/brq/store/trips — الطلب المفتوح + آخر الطلبات */
router.get('/trips', requireStore, async (req, res) => {
  const trips = await Trip.find({ store: req.store._id }).sort({ requestedAt: -1 }).limit(20).lean();
  res.json({ success: true, trips: trips.map((t) => publicTrip(t, 'store')) });
});

/**
 * POST /api/brq/store/trips — طلب سائق:
 *   { stops: [{ phone (إلزامي), areaId?, lat?, lng?, name?, note? }, ...] }  — زبون أو أكثر
 *   (أو الحقول المفردة: areaId + customerPhone). لكل زبون: منطقة أو موقع (رابط مشاركة/خريطة).
 */
router.post('/trips', requireStore, async (req, res, next) => {
  try {
    const trip = await dispatch.createTripForStore(req.store, req.body || {});
    res.status(201).json({ success: true, trip: publicTrip(trip, 'store') });
  } catch (e) { next(e); }
});

/** POST /api/brq/store/estimate  { stops: [{ areaId?, lat?, lng? }] } — تقدير فوري للطلب قبل إرساله */
router.post('/estimate', requireStore, async (req, res, next) => {
  try {
    const { estimateInput } = require('../services/priceSheet');
    res.json({ success: true, ...(await estimateInput(req.store.location, req.body && req.body.stops)) });
  } catch (e) { next(e); }
});

/** POST /api/brq/store/trips/:id/stops/:stopId/location  { lat, lng } — موقع زبون بعد الطلب (رابط وصل لاحقاً) */
router.post('/trips/:id/stops/:stopId/location', requireStore, async (req, res, next) => {
  try {
    const trip = await dispatch.setStopLocation(req.params.id, req.params.stopId, { lat: Number(req.body.lat), lng: Number(req.body.lng) }, { storeId: req.store._id });
    res.json({ success: true, trip: publicTrip(trip, 'store') });
  } catch (e) { next(e); }
});

router.post('/trips/:id/cancel', requireStore, async (req, res, next) => {
  try {
    const trip = await dispatch.cancelTrip(req.params.id, { storeId: req.store._id });
    res.json({ success: true, trip: publicTrip(trip, 'store') });
  } catch (e) { next(e); }
});

/** POST /api/brq/store/trips/:id/pickup — المتجر يؤكد أن السائق استلم الطلب: تبدأ الرحلة وتُحسب فتحة العداد */
router.post('/trips/:id/pickup', requireStore, async (req, res, next) => {
  try {
    const trip = await dispatch.confirmPickup(req.params.id, req.store._id);
    res.json({ success: true, trip: publicTrip(trip, 'store') });
  } catch (e) { next(e); }
});

/** POST /api/brq/store/trips/:id/rate  { stars 1..5 } — بعد اكتمال التوصيلة */
router.post('/trips/:id/rate', requireStore, async (req, res, next) => {
  try {
    const stars = Number(req.body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, message: 'التقييم من 1 إلى 5' });
    }
    await dispatch.rateDriver(req.params.id, req.store._id, stars);
    res.json({ success: true });
  } catch (e) { next(e); }
});

/** POST /api/brq/store/preview-sheet  { lat, lng } — حسبة فورية وهو يحرّك العلامة، بلا حفظ */
router.post('/preview-sheet', limiter(60), async (req, res) => {
  const { buildPriceSheet } = require('../services/priceSheet');
  const { getSettings } = require('../settings');
  const location = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
  if (!isValidPoint(location)) return res.status(400).json({ success: false, message: 'موقع غير صالح' });
  const [settings, areas] = await Promise.all([getSettings(), Area.find({ active: true }).lean()]);
  res.json({ success: true, sheet: buildPriceSheet(location, areas, settings) });
});

/** PUT /api/brq/store/location  { lat, lng } — تحديث موقع المتجر وإرجاع الكشف المحدَّث فوراً */
router.put('/location', requireStore, async (req, res) => {
  const { buildPriceSheet } = require('../services/priceSheet');
  const { getSettings } = require('../settings');
  const location = { lat: Number(req.body.lat), lng: Number(req.body.lng), at: new Date() };
  if (!isValidPoint(location)) return res.status(400).json({ success: false, message: 'موقع غير صالح' });
  const store = await Store.findByIdAndUpdate(req.store._id, { $set: { location } }, { new: true });
  const [settings, areas] = await Promise.all([getSettings(), Area.find({ active: true }).lean()]);
  res.json({ success: true, store: publicStore(store), sheet: buildPriceSheet(store.location, areas, settings) });
});

/* ───── جرد المتجر وكشوفه (بالشعار والختم المعتمد) ───── */
const cfg = require('../config');
const ledger = require('../services/ledgerService');
const docs = require('../receipts');

/** GET /api/brq/store/ledger?from&to — جردي: توصيلاتي وأجورها */
router.get('/ledger', requireStore, async (req, res, next) => {
  try { res.json({ success: true, ...(await ledger.storeAccount(req.store._id, { from: req.query.from, to: req.query.to })) }); }
  catch (e) { next(e); }
});

/** GET /api/brq/store/print/price-sheet — كشف أسعار المناطق من موقعي (A4 للطباعة من المتصفح) */
router.get('/print/price-sheet', requireStore, async (req, res, next) => {
  try {
    const { priceSheetForStore } = require('../services/priceSheet');
    const { getSettings } = require('../settings');
    const st = req.store;
    const [sheet, settings] = await Promise.all([priceSheetForStore(st), getSettings()]);
    res.json({ success: true, html: docs.priceSheetA4Html({ brand: cfg.brand, storeName: st.name, storePhone: st.phone, storeLocation: st.location, sheet, settings }) });
  } catch (e) { next(e); }
});

/** GET /api/brq/store/print/statement?from&to — كشف حسابي (A4) */
router.get('/print/statement', requireStore, async (req, res, next) => {
  try {
    const l = await ledger.storeAccount(req.store._id, { from: req.query.from, to: req.query.to });
    res.json({ success: true, html: docs.storeStatementHtml({ brand: cfg.brand, store: req.store, l, from: req.query.from, to: req.query.to }) });
  } catch (e) { next(e); }
});

/** POST /api/brq/store/logout — يُبطل كل جلسات المتجر */
router.post('/logout', requireStore, async (req, res) => {
  await Store.updateOne({ _id: req.store._id }, { $inc: { tokenVersion: 1 } });
  res.json({ success: true });
});

module.exports = router;
