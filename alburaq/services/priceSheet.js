/**
 * ورقة الأسعار التقديرية للمتجر حسب المناطق.
 * تُحسب تلقائياً من موقع المتجر ومركز كل منطقة، فلا تحتاج إدخالاً يدوياً:
 *   التقدير = فتحة العداد + (المسافة الهوائية لمركز المنطقة × سعر الكم)
 * السعر النهائي يُحسب عند التسليم من موقع الزبون الدقيق.
 */
const { haversineKm, isValidPoint } = require('../geo');
const { getSettings } = require('../settings');
const Area = require('../models/Area');

function buildPriceSheet(storeLocation, areas, settings) {
  if (!isValidPoint(storeLocation)) return [];
  return areas
    .filter((a) => a.active !== false && isValidPoint(a.center))
    .map((a) => {
      const km = haversineKm(storeLocation, a.center);
      return {
        areaId: String(a._id || a.id),
        areaName: a.name,
        km,
        estimateFils: settings.meterFlagFils + Math.round(km * settings.perKmFils),
      };
    })
    .sort((x, y) => x.km - y.km);
}

async function priceSheetForStore(store) {
  const [settings, areas] = await Promise.all([getSettings(), Area.find({ active: true }).lean()]);
  return buildPriceSheet(store.location, areas, settings);
}

/**
 * تقدير طلب بعدة نقاط: المتجر ← النقطة 1 ← النقطة 2 … بالكم الهوائي.
 * كل نقطة: موقعها المحدد إن وُجد، وإلا مركز منطقتها.
 */
function estimateStops(storeLocation, stops, settings) {
  let prev = storeLocation;
  let km = 0;
  for (const s of stops) {
    const p = isValidPoint({ lat: s.lat, lng: s.lng }) ? { lat: s.lat, lng: s.lng } : (isValidPoint(s.areaCenter) ? s.areaCenter : null);
    if (!p || !isValidPoint(prev)) continue;
    km += haversineKm(prev, p);
    prev = p;
  }
  km = Math.round(km * 100) / 100;
  return { km, estimateFils: settings.meterFlagFils + Math.round(km * settings.perKmFils) };
}

/** تقدير فوري أثناء تعبئة الطلب (بلا رقم زبون): [{ areaId?, lat?, lng? }] */
async function estimateInput(storeLocation, raw) {
  const settings = await getSettings();
  const areas = await Area.find({ active: true }).lean();
  const byId = new Map(areas.map((a) => [String(a._id), a]));
  const stops = (Array.isArray(raw) ? raw : []).slice(0, 10).map((r) => {
    const a = r && r.areaId ? byId.get(String(r.areaId)) : null;
    return { lat: r && r.lat !== '' && r.lat != null ? Number(r.lat) : null, lng: r && r.lng !== '' && r.lng != null ? Number(r.lng) : null, areaCenter: a ? a.center : null };
  });
  return estimateStops(storeLocation, stops, settings);
}

module.exports = { buildPriceSheet, priceSheetForStore, estimateStops, estimateInput };
