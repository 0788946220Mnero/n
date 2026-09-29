/**
 * خدمة حساب رسوم التوصيل — مصدر الحقيقة الوحيد (الخادم يحسب، والموقع يعرض ما يعيده).
 *
 * طريقتان تُختاران من إعدادات التوصيل في لوحة التحكم:
 *
 * 1) perKm (الافتراضية القديمة):
 *    ضمن freeDistanceKm مجاني، وما بعدها كل كيلومتر (يُقرَّب لأعلى) × pricePerKm.
 *    مثال (free=1, price=0.5): 1.0km → 0.00 | 1.1km → 0.50 | 2.1km → 1.00
 *
 * 2) tiered (شرائح متناقصة):
 *    - أول tier1Km: سعر ثابت tier1Fee (حدّ أدنى — 0 يجعلها مجانية)
 *    - بعدها حتى tier2Km: كل كيلومتر × tier2PerKm
 *    - بعد tier2Km حتى أقصى مسافة: كل كيلومتر × tier3PerKm
 *    الكيلومتر الناقص يُحسب كاملاً.
 *    مثال (2كم=1.000، ثم 0.250/كم حتى 4، ثم 0.150/كم):
 *      1.5km → 1.000 | 2.3km → 1.250 | 4.0km → 1.500 | 5.2km → 1.800
 */

const { calculateDistance } = require('./distanceService');

const DEFAULTS = {
  freeDistanceKm: 1,
  pricePerKm: 0.5,
  maxDistanceKm: 10,
  distanceMode: 'straight',
  pricingMode: 'perKm',
  tier1Km: 2,
  tier1Fee: 1,
  tier2Km: 4,
  tier2PerKm: 0.25,
  tier3PerKm: 0.15,
};

/** كسور الحساب العشري (2.0000001) لا تضيف كيلومتراً كاملاً. */
const EPS = 1e-9;

/** طريقة التقريب — غيّرها هنا فقط إن أردت نظاماً مختلفاً لاحقاً. */
const roundBillableKm = (extraKm) => Math.ceil(extraKm - EPS);

/**
 * يقرأ الإعدادات حقلاً حقلاً: كائن التوصيل قد يصل كمستند Mongoose متداخل،
 * ونشره (...) لا ينسخ حقوله دائماً.
 */
const normalize = (settings = {}) => {
  const cfg = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = settings ? settings[key] : undefined;
    cfg[key] = v === undefined || v === null || v === '' ? DEFAULTS[key] : v;
  }
  for (const key of ['freeDistanceKm', 'pricePerKm', 'maxDistanceKm', 'tier1Km', 'tier1Fee', 'tier2Km', 'tier2PerKm', 'tier3PerKm']) {
    const n = Number(cfg[key]);
    cfg[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[key];
  }
  if (cfg.tier2Km < cfg.tier1Km) cfg.tier2Km = cfg.tier1Km; // الشريحة الثانية لا تبدأ قبل الأولى
  return cfg;
};

const money = (v) => Number(Number(v).toFixed(3));

/** الشرائح المتناقصة. */
const tieredFee = (distanceKm, cfg) => {
  if (distanceKm <= 0) return 0;
  let fee = cfg.tier1Fee;                                   // أول tier1Km بسعر ثابت
  const inTier2 = Math.min(distanceKm, cfg.tier2Km) - cfg.tier1Km;
  if (inTier2 > EPS) fee += roundBillableKm(inTier2) * cfg.tier2PerKm;
  const inTier3 = distanceKm - cfg.tier2Km;
  if (inTier3 > EPS) fee += roundBillableKm(inTier3) * cfg.tier3PerKm;
  return money(fee);
};

/** حساب الرسوم من مسافة معلومة. */
const feeForDistance = (distanceKm, settings = {}) => {
  const cfg = normalize(settings);
  if (cfg.pricingMode === 'tiered') return tieredFee(distanceKm, cfg);

  const extra = distanceKm - cfg.freeDistanceKm;
  if (extra <= EPS) return 0;
  return money(roundBillableKm(extra) * cfg.pricePerKm);
};

/**
 * الحساب الكامل: المسافة + الرسوم + التحقق من النطاق.
 * يُستخدم في الخادم (مصدر الحقيقة) وفي معاينة السعر للزبون.
 *
 * @returns {Promise<{ok, distanceKm, distanceMode, fee, reason?, maxDistanceKm}>}
 */
const quoteDelivery = async ({
  restaurantLat, restaurantLng, customerLat, customerLng, settings = {},
}) => {
  const cfg = normalize(settings);

  const valid = (v) => typeof v === 'number' && Number.isFinite(v);
  if (![restaurantLat, restaurantLng].every(valid)) {
    return { ok: false, reason: 'RESTAURANT_LOCATION_MISSING', fee: 0, distanceKm: null };
  }
  if (![customerLat, customerLng].every(valid)) {
    return { ok: false, reason: 'CUSTOMER_LOCATION_MISSING', fee: 0, distanceKm: null };
  }
  if (customerLat < -90 || customerLat > 90 || customerLng < -180 || customerLng > 180) {
    return { ok: false, reason: 'INVALID_COORDINATES', fee: 0, distanceKm: null };
  }

  const { km, mode } = await calculateDistance(
    restaurantLat, restaurantLng, customerLat, customerLng, cfg.distanceMode
  );
  const distanceKm = Number(km.toFixed(2));

  if (distanceKm > cfg.maxDistanceKm) {
    return {
      ok: false,
      reason: 'OUT_OF_RANGE',
      distanceKm,
      distanceMode: mode,
      fee: 0,
      maxDistanceKm: cfg.maxDistanceKm,
    };
  }

  return {
    ok: true,
    distanceKm,
    distanceMode: mode,
    fee: feeForDistance(distanceKm, cfg),
    maxDistanceKm: cfg.maxDistanceKm,
  };
};

module.exports = { quoteDelivery, feeForDistance, roundBillableKm, normalize, DEFAULTS };
