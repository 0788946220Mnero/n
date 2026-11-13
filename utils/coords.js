/*
  ═══════════════════════════════════════════════════════════════
  استخراج إحداثيات الزبون من جسم الطلب — مهما كانت صيغة الواجهة.

  الواجهات تختلف في التسمية، وأي اختلاف بسيط كان يعني ضياع الموقع
  تماماً ووصول الطلب بلا نقطة على الخريطة. هنا نقبل كل الصيغ الشائعة:

    customerLatitude / customerLongitude
    latitude / longitude
    lat / lng | lon | long
    location: { lat, lng } أو { latitude, longitude } أو "31.9,35.9"
    coordinates: [lat, lng] أو { lat, lng }
    رابط خرائط جوجل في أي حقل (locationUrl / mapUrl / address)

  وإن لم يُعثر على شيء نُسجّل مفاتيح الطلب في اللوق، فيُعرف فوراً
  ماذا ترسل الواجهة فعلاً بدل التخمين.
  ═══════════════════════════════════════════════════════════════
*/

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  return Number(String(v).trim());
};

const isValidPair = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
  !(lat === 0 && lng === 0);

// يستخرج زوج إحداثيات من نص: "31.95,35.91" أو رابط خرائط
const fromText = (text) => {
  const s = String(text || '');
  if (!s) return null;

  // روابط خرائط جوجل: ?q=lat,lng | @lat,lng | !3dlat!4dlng | /search/lat,lng
  const patterns = [
    /[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /[?&]destination=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /\/search\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/, // نص خام "31.95, 35.91"
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = toNum(m[1]);
      const lng = toNum(m[2]);
      if (isValidPair(lat, lng)) return { lat, lng, source: 'نص/رابط' };
    }
  }
  return null;
};

const extractCoordinates = (body = {}) => {
  // 1) الأسماء المباشرة، بترتيب الأولوية
  const directPairs = [
    ['customerLatitude', 'customerLongitude'],
    ['latitude', 'longitude'],
    ['lat', 'lng'],
    ['lat', 'lon'],
    ['lat', 'long'],
  ];
  for (const [a, b] of directPairs) {
    const lat = toNum(body[a]);
    const lng = toNum(body[b]);
    if (isValidPair(lat, lng)) return { lat, lng, source: `${a}/${b}` };
  }

  // 2) كائنات متداخلة
  for (const key of ['location', 'coords', 'coordinates', 'customerLocation', 'geo']) {
    const v = body[key];
    if (!v) continue;

    if (Array.isArray(v) && v.length === 2) {
      const [x, y] = v.map(toNum);
      if (isValidPair(x, y)) return { lat: x, lng: y, source: `${key}[]` };
      if (isValidPair(y, x)) return { lat: y, lng: x, source: `${key}[] (مقلوب)` };
    }

    if (typeof v === 'object') {
      const lat = toNum(v.lat ?? v.latitude);
      const lng = toNum(v.lng ?? v.lon ?? v.long ?? v.longitude);
      if (isValidPair(lat, lng)) return { lat, lng, source: `${key}.lat/lng` };
    }

    if (typeof v === 'string') {
      const found = fromText(v);
      if (found) return { ...found, source: `${key} (${found.source})` };
    }
  }

  // 3) روابط الخرائط في الحقول النصية
  for (const key of ['locationUrl', 'mapUrl', 'mapsUrl', 'googleMapsUrl', 'address', 'notes']) {
    const found = fromText(body[key]);
    if (found) return { ...found, source: `${key} (رابط خرائط)` };
  }

  return null;
};

module.exports = { extractCoordinates, isValidPair };
