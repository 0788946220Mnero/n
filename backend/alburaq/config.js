/**
 * إعدادات شركة البراق (التوصيل) — وحدة داخل خادم ديار نفسه، فتشاركه:
 *   قاعدة MONGO_URI، و JWT_SECRET، ومستخدمي الإدارة، و FIREBASE_*، وسيرفر الصور.
 * مجموعاتها في القاعدة تبدأ بـ brq_ فلا تتداخل مع المطعم.
 */
const jwtSecret = process.env.JWT_SECRET || 'dev-only-insecure-secret';

module.exports = {
  brand: process.env.BRQ_BRAND_NAME || 'شركة البراق',
  jwtSecret,
  // صلاحية رمز التحقق OTP للسائق بالأيام (افتراضي سنة)
  otpTtlDays: Number(process.env.OTP_TTL_DAYS || 365),
  // سائق بلا موقع خلال هذه المدة يُعدّ غير متصل
  locationStaleMs: Number(process.env.LOCATION_STALE_MS || 2 * 60 * 1000),
};
