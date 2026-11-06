/**
 * شكل الطلب للوحات. بيانات الزبون تُكشف حسب الدور:
 *  • الإدارة: كل شيء.
 *  • المتجر: رقم الزبون وموقعه (هو من أدخلها).
 *  • السائق: مواقع الزبائن بعد القبول، وأرقامهم فقط بعد تأكيد الاستلام (picked).
 *  • stops: نقاط التسليم (زبون أو أكثر) بنفس قواعد الظهور.
 */
function pricingFor(p, viewer) {
  if (!p) return null;
  if (viewer === 'store') return { meterFlagFils: p.meterFlagFils, perKmFils: p.perKmFils, storeChargeFils: p.storeChargeFils ?? null };
  if (viewer === 'driver') return { meterFlagFils: p.meterFlagFils, driverFils: p.driverFils ?? null };
  return p;
}

function publicTrip(t, viewer = 'admin') {
  if (typeof viewer !== 'string') viewer = 'admin'; // حماية من استخدامه مباشرة في map()
  const picked = ['picked', 'completed'].includes(t.status);
  const customerLoc = t.customer && Number.isFinite(t.customer.lat) && Number.isFinite(t.customer.lng) ? { lat: t.customer.lat, lng: t.customer.lng } : null;
  const base = {
    id: String(t._id),
    status: t.status,
    storeId: String(t.store),
    storeName: t.storeName,
    storeLocation: t.storeLocation || null,
    areaName: t.areaName,
    areaCenter: t.areaCenter || null,
    km: t.km ?? null,
    pricing: pricingFor(t.pricing, viewer),
    driver: t.driver ? { id: String(t.driver), name: t.driverName } : null,
    wave: t.wave,
    waveEndsAt: t.waveEndsAt || null,
    // مصدر الطلب: متجر، كول سنتر البراق، أو «حالة الطلبات» في المطعم (برقم طلب المطعم)
    source: t.source && t.source.kind ? { kind: t.source.kind, orderNumber: t.source.orderNumber || '', channel: t.source.channel || '' } : { kind: 'store', orderNumber: '', channel: '' },
    receiptNo: t.receiptNo || '',
    requestedAt: t.requestedAt,
    acceptedAt: t.acceptedAt || null,
    pickedAt: t.pickedAt || null,
    // كيف استُلم من المطعم: code (المطعم أدخل رمز السائق) | driver (أكّده السائق بنفسه) | store | admin
    pickupBy: t.pickupBy || '',
    completedAt: t.completedAt || null,
    cancelledAt: t.cancelledAt || null,
    rated: !!t.rated,
  };
  const showPhones = viewer !== 'driver' || picked;
  base.estimateFils = t.estimateFils ?? null;
  base.stops = (t.stops || []).map((x) => ({
    id: String(x._id),
    name: x.name || '',
    phone: showPhones ? x.phone : null,
    areaName: x.areaName || '',
    areaCenter: x.areaCenter && Number.isFinite(x.areaCenter.lat) ? x.areaCenter : null,
    location: Number.isFinite(x.lat) && Number.isFinite(x.lng) ? { lat: x.lat, lng: x.lng } : null,
    locationSource: x.locationSource || '',
    note: x.note || '',
    status: x.status,
    deliveredAt: x.deliveredTime || null,
    // موقع السائق لحظة التسليم (GPS) — يدخل السجل
    deliveredPoint: x.deliveredAt && Number.isFinite(x.deliveredAt.lat) ? { lat: x.deliveredAt.lat, lng: x.deliveredAt.lng } : null,
    deliveredAccuracy: x.deliveredAccuracy ?? null,
    legKm: x.legKm ?? null,
    // للإدارة والمتجر: تسليم بعيد عن الموقع المحدد مسبقاً (مراجعة فقط)
    offsetM: viewer === 'driver' ? undefined : (x.offsetM ?? null),
  }));
  if (viewer === 'driver') {
    // رمز الاستلام للسائق وحده (لا يراه المطعم — يأخذه من شاشة السائق)
    return { ...base, pickupCode: t.status === 'assigned' ? t.pickupCode || '' : '', customerName: t.customer ? t.customer.name || '' : '', customerLocation: customerLoc, customerPhone: picked && t.customer && t.customer.phone ? t.customer.phone : null };
  }
  if (viewer === 'store') {
    return { ...base, customerName: t.customer ? t.customer.name || '' : '', customerLocation: customerLoc, customerPhone: t.customer ? t.customer.phone : null };
  }
  return {
    ...base, customerName: t.customer ? t.customer.name || '' : '', customerLocation: customerLoc, customerPhone: t.customer ? t.customer.phone : null,
    pickupPoint: t.pickupPoint && Number.isFinite(t.pickupPoint.lat) ? { lat: t.pickupPoint.lat, lng: t.pickupPoint.lng } : null,
    pickupOffsetM: t.pickupOffsetM ?? null,
  };
}

module.exports = { publicTrip };
