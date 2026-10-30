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
  if (!text.trim()) return res.status(400).json({ success: false, message: 'الصق رابط الموقع' });
  try {
    const p = await resolve(text);
    res.json({ success: true, lat: p.lat, lng: p.lng });
  } catch (e) {
    res.status(e.status || 400).json({ success: false, message: e.message || 'تعذّر قراءة الموقع' });
  }
});

module.exports = router;
