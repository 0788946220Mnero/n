const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const PosDeviceConfig = require('../models/PosDeviceConfig');
const { logActivity } = require('../utils/activity');

/*
 * /api/pos-devices — رمز إعدادات أجهزة الكاشير (DiyarPOS):
 *   GET  /pin  أجهزة البيع (مدير النظام، المدير، الكاشير): بصمة الرمز ليتحقق التطبيق محلياً بلا إنترنت
 *   PUT  /pin  مدير النظام وحده: تعيين الرمز أو إعادة تعيينه (6–8 أرقام)
 * الرمز نفسه لا يُحفظ ولا يُرسل أبداً — PBKDF2-SHA256 بملح عشوائي.
 */
const ITER = 210000;
const KEYLEN = 32;
const nameOf = (u) => (u && (u.name || u.username)) || '';

function weakPin(pin) {
  if (!/^\d{6,8}$/.test(pin)) return 'الرمز من 6 إلى 8 أرقام';
  if (/^(\d)\1+$/.test(pin)) return 'لا تكرر نفس الرقم';
  const d = pin.split('').map(Number);
  const step = d[1] - d[0];
  if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return 'لا تستعمل أرقاماً متسلسلة';
  if (/^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1$/.test(pin)) return 'لا تكرر نمطاً قصيراً';
  return '';
}
const derive = (pin, salt, iter) => crypto.pbkdf2Sync(String(pin), Buffer.from(salt, 'base64'), iter, KEYLEN, 'sha256').toString('base64');

const publicPin = (c) => (c && c.pinHash
  ? { set: true, alg: 'pbkdf2-sha256', salt: c.pinSalt, iter: c.pinIter, hash: c.pinHash, version: c.pinVersion, setAt: c.pinSetAt, setByName: c.pinSetByName }
  : { set: false, version: (c && c.pinVersion) || 0 });

const setLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'محاولات كثيرة — انتظر قليلاً' } });

router.use(protect);

router.get('/pin', authorize('admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const c = await PosDeviceConfig.findOne({ key: 'main' }).lean();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, pin: publicPin(c) });
  } catch (e) { next(e); }
});

router.put('/pin', setLimiter, authorize('admin'), async (req, res, next) => {
  try {
    const pin = String((req.body && req.body.pin) || '').trim();
    const why = weakPin(pin);
    if (why) return res.status(400).json({ success: false, message: why });
    const salt = crypto.randomBytes(16).toString('base64');
    const prev = await PosDeviceConfig.findOne({ key: 'main' }).lean();
    const c = await PosDeviceConfig.findOneAndUpdate(
      { key: 'main' },
      { $set: { pinSalt: salt, pinHash: derive(pin, salt, ITER), pinIter: ITER, pinVersion: ((prev && prev.pinVersion) || 0) + 1, pinSetAt: new Date(), pinSetByName: nameOf(req.user) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    logActivity({ req, action: 'posdevice.pin_set', details: { version: c.pinVersion } });
    // أجهزة الكاشير المفتوحة تجلب البصمة الجديدة فوراً (بلا الرمز ولا البصمة في البث)
    try { require('../services/realtimeService').broadcast('print.pin', { version: c.pinVersion }); } catch (_) { /* */ }
    const out = publicPin(c);
    res.json({ success: true, pin: { set: true, version: out.version, setAt: out.setAt, setByName: out.setByName } });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.weakPin = weakPin;
module.exports.derive = derive;
