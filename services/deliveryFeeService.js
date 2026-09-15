/**
 * خدمة حساب رسوم التوصيل.
 * قاعدة الحساب (قابلة للتغيير من مكان واحد):
 *   - المسافة ضمن freeDistanceKm  → مجاني
 *   - ما بعدها: يُقرَّب كل كيلومتر إضافي لأعلى (Ceiling) × pricePerKm
 *
 * مثال (free=1, price=0.5):  1.0km → 0.00 | 1.1km → 0.50 | 2.1km → 1.00 | 3km → 1.00
 */

const { calculateDistance } = require('./distanceService');

const DEFAULTS = {
  freeDistanceKm: 1,
  pricePerKm: 0.5,
  maxDistanceKm: 10,
  distanceMode: 'straight',
};

/** طريقة التقريب — غيّرها هنا فقط إن أردت نظاماً مختلفاً لاحقاً. */
const roundBillableKm = (extraKm) => Math.ceil(extraKm);

/** حساب الرسوم من مسافة معلومة. */
const feeForDistance = (distanceKm, settings = {}) => {
  const cfg = { ...DEFAULTS, ...settings };
  const extra = distanceKm - Number(cfg.freeDistanceKm);
  if (extra <= 0) return 0;
  const billable = roundBillableKm(extra);
  return Number((billable * Number(cfg.pricePerKm)).toFixed(2));
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
  const cfg = { ...DEFAULTS, ...settings };

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

  if (distanceKm > Number(cfg.maxDistanceKm)) {
    return {
      ok: false,
      reason: 'OUT_OF_RANGE',
      distanceKm,
      distanceMode: mode,
      fee: 0,
      maxDistanceKm: Number(cfg.maxDistanceKm),
    };
  }

  return {
    ok: true,
    distanceKm,
    distanceMode: mode,
    fee: feeForDistance(distanceKm, cfg),
    maxDistanceKm: Number(cfg.maxDistanceKm),
  };
};

module.exports = { quoteDelivery, feeForDistance, roundBillableKm };
