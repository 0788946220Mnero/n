const cfg = require('./config');

/** الحقول الآمنة للسائق — لا تُرجع أبداً pinHash أو otpHash. */
function publicDriver(d, now = Date.now()) {
  const loc = d.lastLocation && d.lastLocation.at ? d.lastLocation : null;
  const online = !!loc && now - new Date(loc.at).getTime() < cfg.locationStaleMs;
  const count = d.ratingCount || 0;
  return {
    id: String(d._id),
    name: d.name,
    phone: d.phone,
    vehicle: d.vehicle || '',
    plate: d.plate || '',
    nationalId: d.nationalId || '',
    permitNo: d.permitNo || '',
    permitExpiresAt: d.permitExpiresAt || null,
    active: !!d.active,
    status: d.status,
    online,
    rating: count ? Math.round(((d.ratingSum || 0) / count) * 10) / 10 : null,
    ratingCount: count,
    currentTrip: d.currentTrips && d.currentTrips.length ? String(d.currentTrips[0]) : null,
    currentTrips: (d.currentTrips || []).map(String),
    openTrips: (d.currentTrips || []).length,
    hasOtp: !!d.otpHash,
    otpExpiresAt: d.otpExpiresAt || null,
    lockedUntil: d.lockedUntil || null,
    lastLocation: loc
      ? { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy ?? null, heading: loc.heading ?? null, speed: loc.speed ?? null, at: loc.at }
      : null,
  };
}

module.exports = { publicDriver };
