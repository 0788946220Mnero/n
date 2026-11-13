const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** المسافة الهوائية (خط مستقيم) بين نقطتين بالكيلومتر، مقرّبة لمنزلتين. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * 100) / 100;
}

const isValidPoint = (p) =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
  p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 && !(p.lat === 0 && p.lng === 0);

module.exports = { haversineKm, isValidPoint };

/** هل النقطة (موقع السائق) ضمن نصف قطر بالمتر من نقطة الزبون؟ */
function isWithinMeters(a, b, meters) {
  return isValidPoint(a) && isValidPoint(b) && haversineKm(a, b) * 1000 <= meters;
}

module.exports.isWithinMeters = isWithinMeters;
