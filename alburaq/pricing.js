/**
 * التسعير بالقرش (الدينار = 100 قرش) — أعداد صحيحة فقط.
 *
 *  • فتحة العداد: تُحتسب عند تأكيد استلام المتجر للطلب، وتذهب كاملة للسائق (افتراضي 76).
 *  • الكيلومتر الهوائي: يُحسب عند التسليم بين المتجر وموقع الزبون، لكل كم سعر (افتراضي 18).
 *      - الشركة تأخذ نسبة ربح ثابتة بالقرش من كل كم (companyCutPerKmFils).
 *      - الباقي يدخل جرد السائق مع الطلب.
 *  • المتجر يدفع: فتحة العداد + (الكم × سعر الكم).
 *  • أجرة السائق = فتحة العداد + (الكم × (سعر الكم − نسبة الشركة)).
 */
function meterFlagPricing({ meterFlagFils }) {
  return { meterFlagFils };
}

function deliveryPricing({ km, meterFlagFils, perKmFils, companyCutPerKmFils }) {
  const cut = Math.min(Math.max(0, companyCutPerKmFils), perKmFils);
  const distanceFils = Math.round(Math.max(0, km) * perKmFils);
  const companyFils = Math.round(Math.max(0, km) * cut);
  const driverDistanceFils = distanceFils - companyFils;
  return {
    km: Math.round(Math.max(0, km) * 100) / 100,
    meterFlagFils,
    perKmFils,
    companyCutPerKmFils: cut,
    distanceFils,
    companyFils,
    driverFils: meterFlagFils + driverDistanceFils,
    storeChargeFils: meterFlagFils + distanceFils,
  };
}

module.exports = { meterFlagPricing, deliveryPricing };
