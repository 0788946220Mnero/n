const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Driver = require('../models/Driver');
const Trip = require('../models/Trip');
const { normalizePhone, isValidPin, isValidOtpFormat, compareSecret } = require('../security');
const { nextFailureState, isLocked } = require('../loginPolicy');
const { signDriverToken, requireDriver } = require('../auth');
const { publicDriver } = require('../publicDriver');
const { publicTrip } = require('../publicTrip');
const realtime = require('../realtime');
const dispatch = require('../services/dispatchService');
const { driverLedger } = require('../services/ledgerService');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-pin-for-timing', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة، حاول بعد قليل' },
});

const INVALID = { success: false, message: 'بيانات الدخول غير صحيحة' };

/** POST /api/brq/driver/login  { phone, pin, otp } — الثلاثة مطلوبة دائماً */
router.post('/login', loginLimiter, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  const otp = String(req.body.otp || '').replace(/\s+/g, '');
  if (!phone || !isValidPin(pin) || !isValidOtpFormat(otp)) {
    return res.status(400).json({ success: false, message: 'أدخل الرقم والـ PIN ورمز التحقق كاملة' });
  }

  const driver = await Driver.findOne({ phone });
  const now = Date.now();
  if (!driver || !driver.active) {
    await compareSecret(pin, DUMMY_HASH);
    return res.status(401).json(INVALID);
  }
  if (isLocked(driver.lockedUntil, now)) return res.status(401).json(INVALID);

  const pinOk = await compareSecret(pin, driver.pinHash);
  const otpValid = !!driver.otpExpiresAt && driver.otpExpiresAt.getTime() > now;
  const otpOk = otpValid && (await compareSecret(otp, driver.otpHash));

  if (!(pinOk && otpOk)) {
    await Driver.updateOne({ _id: driver._id }, { $set: nextFailureState(driver.failedAttempts, now) });
    return res.status(401).json(INVALID);
  }
  await Driver.updateOne({ _id: driver._id }, { $set: { failedAttempts: 0, lockedUntil: null } });
  const fresh = await Driver.findById(driver._id);
  return res.json({ success: true, token: signDriverToken(fresh, req.body.remember !== false), driver: publicDriver(fresh, now) });
});

router.get('/me', requireDriver, async (req, res) => {
  res.json({ success: true, driver: publicDriver(req.driver) });
});

/** POST /api/brq/driver/location  { lat, lng, accuracy?, heading?, speed? } */
router.post('/location', requireDriver, async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
    return res.status(400).json({ success: false, message: 'إحداثيات غير صالحة' });
  }
  const opt = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const loc = { lat, lng, accuracy: opt(req.body.accuracy), heading: opt(req.body.heading), speed: opt(req.body.speed), at: new Date() };
  const updated = await Driver.findByIdAndUpdate(req.driver._id, { $set: { lastLocation: loc } }, { new: true });
  realtime.toAdmins({ type: 'driver.location', driver: publicDriver(updated) });
  // المتاجر التي ينتظرها هذا السائق ترى موقعه ووقت وصوله لحظياً
  if (updated && (updated.currentTrips || []).length) dispatch.onDriverMoved(updated).catch(() => {});
  res.json({ success: true });
});

const STATUSES = ['offline', 'available', 'busy'];

/** POST /api/brq/driver/status  { status } — "busy" و"available" تُدار تلقائياً مع التوصيلات */
router.post('/status', requireDriver, async (req, res) => {
  const status = String(req.body.status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
  if (req.driver.currentTrips && req.driver.currentTrips.length && status === 'offline') {
    return res.status(409).json({ success: false, message: 'لديك توصيلات مفتوحة، أكملها أولاً' });
  }
  const updated = await Driver.findByIdAndUpdate(req.driver._id, { $set: { status } }, { new: true });
  dispatch.publishDriver(updated);
  res.json({ success: true, driver: publicDriver(updated) });
});

/** GET /api/brq/driver/trip — توصيلته الحالية */
router.get('/trips', requireDriver, async (req, res) => {
  const list = await Trip.find({ _id: { $in: req.driver.currentTrips || [] } }).sort({ acceptedAt: 1 }).lean();
  res.json({ success: true, trips: list.map((t) => publicTrip(t, 'driver')) });
});

router.post('/trips/:id/accept', requireDriver, async (req, res, next) => {
  try {
    const trip = await dispatch.acceptOffer(req.params.id, req.driver._id);
    res.json({ success: true, trip: publicTrip(trip, 'driver') });
  } catch (e) { next(e); }
});

router.post('/trips/:id/decline', requireDriver, async (req, res, next) => {
  try {
    await dispatch.declineOffer(req.params.id, req.driver._id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

/** POST /api/brq/driver/trips/:id/stops/:stopId/complete — تم التسليم لهذا الزبون (بأي ترتيب) */
router.post('/trips/:id/stops/:stopId/complete', requireDriver, async (req, res, next) => {
  try {
    const trip = await dispatch.completeStop(req.params.id, req.driver._id, req.params.stopId);
    res.json({ success: true, trip: publicTrip(trip, 'driver') });
  } catch (e) { next(e); }
});

/** POST /api/brq/driver/trips/:id/stops/:stopId/location  { lat, lng } — الزبون أرسل موقعه للسائق (رابط مشاركة) */
router.post('/trips/:id/stops/:stopId/location', requireDriver, async (req, res, next) => {
  try {
    const trip = await dispatch.setStopLocation(req.params.id, req.params.stopId, { lat: Number(req.body.lat), lng: Number(req.body.lng) }, { driverId: req.driver._id });
    res.json({ success: true, trip: publicTrip(trip, 'driver') });
  } catch (e) { next(e); }
});

/** توافق: تم التسليم حين تبقى نقطة واحدة */
router.post('/trips/:id/complete', requireDriver, async (req, res, next) => {
  try {
    const trip = await dispatch.completeTrip(req.params.id, req.driver._id);
    res.json({ success: true, trip: publicTrip(trip, 'driver') });
  } catch (e) { next(e); }
});

/** GET /api/brq/driver/history?limit — سجل التوصيلات المكتملة (تختفي من الخريطة وتدخل هنا) */
router.get('/history', requireDriver, async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 40));
    const list = await Trip.find({ driver: req.driver._id, status: 'completed' }).sort({ completedAt: -1 }).limit(limit).lean();
    res.json({ success: true, trips: list.map((t) => ({ ...publicTrip(t, 'driver'), completedAt: t.completedAt, receiptNo: t.receiptNo || '' })) });
  } catch (e) { next(e); }
});

/** GET /api/brq/driver/ledger — جرد السائق: أجرته فقط */
router.get('/ledger', requireDriver, async (req, res, next) => {
  try { res.json({ success: true, ...(await driverLedger(req.driver._id, { from: req.query.from, to: req.query.to })) }); }
  catch (e) { next(e); }
});

/** GET /api/brq/driver/trips/:id/receipt — وصل توصيلة مكتملة (للطباعة أو الحفظ) */
router.get('/trips/:id/receipt', requireDriver, async (req, res, next) => {
  try {
    const t = await Trip.findOne({ _id: req.params.id, driver: req.driver._id, status: 'completed' }).lean();
    if (!t) return res.status(404).json({ success: false, message: 'التوصيلة غير موجودة' });
    const cfg = require('../config');
    res.json({ success: true, html: require('../receipts').tripReceiptHtml({ brand: cfg.brand, t, viewer: 'admin' }) });
  } catch (e) { next(e); }
});

/** POST /api/brq/driver/logout — يُبطل كل جلسات السائق */
router.post('/logout', requireDriver, async (req, res) => {
  await Driver.updateOne({ _id: req.driver._id }, { $inc: { tokenVersion: 1 } });
  res.json({ success: true });
});

/** GET /notices — تنبيهات إدارة البراق لهذا السائق */
router.get('/notices', requireDriver, async (req, res, next) => {
  try { res.json({ success: true, notices: await require('../services/noticeService').listFor('driver', req.driver._id, req.query.limit) }); }
  catch (e) { next(e); }
});

/** POST /session/renew — تجديد الجلسة بصمت (التطبيق والصفحة يستدعيانه عند الفتح): «تذكرني» لا تنتهي ما دام الجهاز يُستعمل */
router.post('/session/renew', requireDriver, (req, res) => {
  const p = require('jsonwebtoken').decode(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')) || {};
  // rm في التوكنات الجديدة؛ القديمة: الطويلة (أكثر من 8 أيام) كانت «تذكرني»
  const remember = !!p.rm || (p.exp && p.iat && p.exp - p.iat > 8 * 86400);
  res.json({ success: true, token: signDriverToken(req.driver, remember), remember });
});

module.exports = router;
