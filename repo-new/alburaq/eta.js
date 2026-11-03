/**
 * تقدير وقت وصول السائق: المسافة الهوائية × معامل الطرق داخل المدينة ÷ متوسط سرعة الدراجة/السيارة.
 * تقدير عملي (لا خدمة توجيه): يكفي المتجر ليعرف «يصل خلال ~7 دقائق».
 */
const { haversineKm, isValidPoint } = require('./geo');

const ROAD_FACTOR = 1.35;   // الطرق أطول من الخط الهوائي
const CITY_KMH = 24;        // متوسط داخل عمّان مع الإشارات
const ARRIVED_KM = 0.12;    // ضمن ~120 م = وصل

function etaBetween(from, to) {
  if (!isValidPoint(from) || !isValidPoint(to)) return null;
  const km = haversineKm(from, to);
  if (km <= ARRIVED_KM) return { km: Math.round(km * 100) / 100, minutes: 0, arrived: true };
  const minutes = Math.max(1, Math.ceil(((km * ROAD_FACTOR) / CITY_KMH) * 60));
  return { km: Math.round(km * 100) / 100, minutes, arrived: false };
}

/** الهدف التالي للسائق في هذه الرحلة: المتجر قبل الاستلام، ثم أول زبون لم يُسلَّم. */
function nextTarget(trip) {
  if (trip.status === 'assigned') return { kind: 'store', point: trip.storeLocation, name: trip.storeName };
  if (trip.status === 'picked') {
    const s = (trip.stops || []).find((x) => x.status !== 'delivered');
    if (s) {
      const p = isValidPoint({ lat: s.lat, lng: s.lng }) ? { lat: s.lat, lng: s.lng } : s.areaCenter;
      return { kind: 'customer', point: p, name: s.name || s.areaName };
    }
  }
  return null;
}

/** ما يراه المتجر والإدارة عن السائق المقبول: من هو، أين هو، وكم يحتاج للوصول. */
function driverEta(trip, driver) {
  if (!driver || !['assigned', 'picked'].includes(trip.status)) return null;
  const loc = driver.lastLocation && isValidPoint(driver.lastLocation) ? { lat: driver.lastLocation.lat, lng: driver.lastLocation.lng } : null;
  const target = nextTarget(trip);
  const eta = loc && target ? etaBetween(loc, target.point) : null;
  return {
    tripId: String(trip._id),
    driver: {
      id: String(driver._id), name: driver.name, phone: driver.phone || '', vehicle: driver.vehicle || '', plate: driver.plate || '',
      rating: driver.ratingCount ? Math.round((driver.ratingSum / driver.ratingCount) * 10) / 10 : null,
    },
    location: loc,
    locationAt: driver.lastLocation ? driver.lastLocation.at : null,
    target: target ? target.kind : null,
    targetName: target ? target.name : '',
    km: eta ? eta.km : null,
    minutes: eta ? eta.minutes : null,
    arrived: eta ? eta.arrived : false,
  };
}

module.exports = { etaBetween, nextTarget, driverEta, ROAD_FACTOR, CITY_KMH };
