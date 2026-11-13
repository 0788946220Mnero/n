/**
 * منطق اختيار السائقين للطلب — دوال نقية بلا قاعدة بيانات.
 *
 * يُرجع السائقين المؤهلين مرتّبين بالأقرب إلى المتجر، مع استبعاد:
 *  - السائق غير المفعّل أو غير المتصل أو المشغول أو الذي لديه عرض معلّق من قبل
 *  - السائق الذي قيّمه هذا المتجر تقييماً متدنياً
 *  - السائق الذي عُرض عليه هذا الطلب من قبل
 *  - السائق خارج نطاق البحث
 */
const { haversineKm, isValidPoint } = require('./geo');

function pickCandidates({
  drivers,
  store,
  excludeIds = new Set(),
  lowRatedIds = new Set(),
  radiusKm,
  count,
}) {
  if (!isValidPoint(store)) return [];
  const eligible = [];
  for (const d of drivers) {
    if (!d.active || !d.online || d.status !== 'available' || d.hasCurrentTrip) continue;
    if (!isValidPoint(d.lastLocation)) continue;
    if (excludeIds.has(d.id) || lowRatedIds.has(d.id)) continue;
    const distanceKm = haversineKm(store, d.lastLocation);
    if (distanceKm > radiusKm) continue;
    eligible.push({ id: d.id, distanceKm });
  }
  eligible.sort((a, b) => a.distanceKm - b.distanceKm);
  return eligible.slice(0, count);
}

/** السائقون الذين قيّمهم المتجر تقييماً أدنى من الحد الأدنى. */
function lowRatedDriverIds(storeRatings, minStars) {
  // storeRatings: [{ driver: id, avg: number }]
  return new Set(storeRatings.filter((r) => r.avg < minStars).map((r) => String(r.driver)));
}

module.exports = { pickCandidates, lowRatedDriverIds };
