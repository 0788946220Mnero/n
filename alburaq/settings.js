const Settings = require('./models/Settings');

/** القيم الافتراضية — تُعدَّل من لوحة التحكم. التسعير بالقرش. */
const DEFAULTS = {
  meterFlagFils: 76,            // فتحة العداد: تُحسب عند تأكيد الاستلام وتذهب للسائق
  perKmFils: 18,                // سعر الكيلومتر الهوائي الذي يدفعه المتجر
  companyCutPerKmFils: 0,       // نسبة ربح الشركة من كل كم (تُخصم من الـ18) — تحددها أنت
  deliveryRadiusM: 300,         // تسليم أبعد من هذا عن الموقع المحدد مسبقاً يُعلَّم للمراجعة (لا يُمنع)
  offerTimeoutSec: 10,          // مهلة القبول
  waveSize: 5,                  // عدد السائقين في كل موجة
  searchRadiusKm: 10,           // أقصى مسافة من المتجر للسائق
  minStoreRatingForDriver: 3,   // أدنى تقييم من المتجر ليظل السائق يصله طلبه
  maxConcurrentTrips: 1,        // كم رحلة مفتوحة يحمل السائق في وقت واحد (نقاط توصيل متعددة)
};

const LIMITS = {
  meterFlagFils: [0, 100000],
  perKmFils: [0, 100000],
  companyCutPerKmFils: [0, 100000],
  deliveryRadiusM: [50, 2000],
  offerTimeoutSec: [5, 300],
  waveSize: [1, 50],
  searchRadiusKm: [0.5, 100],
  minStoreRatingForDriver: [1, 5],
  maxConcurrentTrips: [1, 5],
};
const FIELDS = Object.keys(DEFAULTS);

async function getSettings() {
  const doc = (await Settings.findOne({ key: 'main' }).lean()) || {};
  const out = {};
  for (const k of FIELDS) out[k] = doc[k] ?? DEFAULTS[k];
  return out;
}

async function updateSettings(input) {
  const set = {};
  for (const k of FIELDS) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    const [lo, hi] = LIMITS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) {
      const err = new Error(`قيمة غير صالحة للحقل ${k}`);
      err.status = 400;
      throw err;
    }
    set[k] = v;
  }
  const current = await getSettings();
  const merged = { ...current, ...set };
  if (merged.companyCutPerKmFils > merged.perKmFils) {
    const err = new Error('نسبة الشركة لا يمكن أن تتجاوز سعر الكم');
    err.status = 400;
    throw err;
  }
  await Settings.updateOne({ key: 'main' }, { $set: set }, { upsert: true });
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULTS };
