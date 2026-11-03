/** /api/geo — قراءة الموقع من رابط مشاركة (يحل الروابط المختصرة على الخادم). */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { resolve } = require('../services/locationResolver');

const router = express.Router();
// مفتوح (صفحة تسجيل المتجر قبل الدخول تحتاجه)، بحد للطلبات
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'محاولات كثيرة، حاول بعد قليل' } });

/** POST /api/geo/resolve  { text } → { lat, lng } */
router.post('/resolve', limiter, async (req, res) => {
  const text = String((req.body && req.body.text) || '').slice(0, 2000);
  const ref = req.body && Number.isFinite(Number(req.body.refLat)) && Number.isFinite(Number(req.body.refLng)) ? { lat: Number(req.body.refLat), lng: Number(req.body.refLng) } : undefined;
  if (!text.trim()) return res.status(400).json({ success: false, message: 'الصق رابط الموقع' });
  try {
    const p = await resolve(text, { ref });
    res.json({ success: true, lat: p.lat, lng: p.lng, approx: !!p.approx, place: p.place || '' });
  } catch (e) {
    res.status(e.status || 400).json({ success: false, message: e.message || 'تعذّر قراءة الموقع' });
  }
});

/*
 * GET /api/brq/geo/search?q=دوار الداخلية — البحث عن معلم (OpenStreetMap / Nominatim).
 * عبر الخادم لا المتصفح: User-Agent صحيح كما تشترط سياسة Nominatim، وذاكرة مؤقتة،
 * وحد طلبات، والنتائج داخل الأردن أولاً.
 */
const { searchPlaces } = require('../services/geocode');
const searchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'بحث كثير، انتظر دقيقة' } });

router.get('/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (q.length < 2) return res.status(400).json({ success: false, message: 'اكتب اسم المعلم (حرفان على الأقل)' });
  try {
    res.json({ success: true, results: await searchPlaces(q) });
  } catch (e) {
    res.status(502).json({ success: false, message: 'تعذّر البحث الآن — جرّب رابط الموقع أو اختر على الخريطة' });
  }
});

module.exports = router;
