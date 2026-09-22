/**
 * خدمة حساب المسافة بين نقطتين.
 * معزولة تماماً عن الواجهة ونظام الطلبات، فيمكن تغيير طريقة الحساب
 * من "مسافة جوية" إلى "مسافة طريق" دون المساس بأي كود آخر.
 */

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * المسافة الجوية (Haversine) — مباشرة وبلا أي خدمة خارجية.
 * ملاحظة: تعطي المسافة بخط مستقيم، لا المسافة التي يقطعها السائق فعلياً.
 */
const straightLineDistance = (lat1, lon1, lat2, lon2) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * مسافة الطريق الفعلية — تحتاج خدمة Routing خارجية.
 *
 * غير مُفعَّلة حالياً عن قصد: المشروع لا يملك أي خدمة Routing،
 * ولن نضع تنفيذاً وهمياً. لتفعيلها لاحقاً:
 *
 *   1) اختر خدمة: OSRM (بلا مفتاح) أو OpenRouteService (مفتاح مجاني)
 *   2) ضع المفتاح في متغيّر بيئة ROUTING_API_KEY (لا داخل الكود)
 *   3) نفّذ النداء هنا وأعد المسافة بالكيلومترات
 *
 * حتى ذلك الحين ترجع null، فيتحوّل النظام تلقائياً للمسافة الجوية.
 */
const roadDistance = async (/* lat1, lon1, lat2, lon2 */) => {
  const apiKey = process.env.ROUTING_API_KEY;
  if (!apiKey) return null; // لا خدمة مضبوطة → لا حساب وهمي
  // مكان تنفيذ نداء Routing API مستقبلاً
  return null;
};

/**
 * الواجهة الموحّدة: تُرجع { km, mode }
 * تحاول مسافة الطريق إن طُلبت وتوفّرت، وإلا تستخدم المسافة الجوية.
 */
const calculateDistance = async (lat1, lon1, lat2, lon2, mode = 'straight') => {
  if (mode === 'road') {
    const road = await roadDistance(lat1, lon1, lat2, lon2);
    if (road != null) return { km: road, mode: 'road' };
  }
  return { km: straightLineDistance(lat1, lon1, lat2, lon2), mode: 'straight' };
};

module.exports = { calculateDistance, straightLineDistance };
