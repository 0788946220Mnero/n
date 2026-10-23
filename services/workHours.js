/**
 * هل المطعم مفتوح الآن؟ (بتوقيت عمّان، نفس منطق منصة الزبائن — يدعم الدوام بعد منتصف الليل)
 * المطعم «متوقف» من لوحة التحكم يُعدّ مغلقاً.
 */
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const TZ = 'Asia/Amman';

function ammanNow(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dayIdx: day < 0 ? at.getDay() : day, minutes: (parseInt(get('hour'), 10) || 0) * 60 + (parseInt(get('minute'), 10) || 0) };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

function isOpenAt(days, at = new Date()) {
  if (!Array.isArray(days) || !days.length) return true; // بلا مواعيد مضبوطة: لا نفترض الإغلاق
  const { dayIdx, minutes } = ammanNow(at);
  const today = days.find((d) => d.day === AR_DAYS[dayIdx]);
  if (today && today.isOpen) {
    const o = toMin(today.openTime); const c = toMin(today.closeTime);
    if (c > o && minutes >= o && minutes < c) return true;
    if (c <= o && minutes >= o) return true;
  }
  const yest = days.find((d) => d.day === AR_DAYS[(dayIdx + 6) % 7]);
  if (yest && yest.isOpen) {
    const o = toMin(yest.openTime); const c = toMin(yest.closeTime);
    if (c <= o && minutes < c) return true;
  }
  return false;
}

async function isOpenNow(at = new Date()) {
  try {
    const Setting = require('../models/Setting');
    const s = await Setting.findOne().lean();
    if (!s) return true;
    if (s.restaurantStatus && s.restaurantStatus.mode === 'stopped') return false;
    return isOpenAt(s.workHours, at);
  } catch (_) { return true; }
}

module.exports = { isOpenAt, isOpenNow, ammanNow, AR_DAYS };
