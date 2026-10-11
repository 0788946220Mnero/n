/**
 * أرقام الهواتف الأردنية: الصيغة الموحّدة +9627XXXXXXXX (نفس PhoneUser)،
 * والطلبات القديمة تحفظ 07XXXXXXXX — نطابق الصيغتين.
 */
function normalizeJo(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^07\d{8}$/.test(p)) p = '+962' + p.slice(1);
  if (/^7\d{8}$/.test(p)) p = '+962' + p;
  if (/^9627\d{8}$/.test(p)) p = '+' + p;
  return /^\+9627\d{8}$/.test(p) ? p : '';
}

/** +9627XXXXXXXX ← 07XXXXXXXX */
const localJo = (intl) => (String(intl || '').startsWith('+962') ? `0${String(intl).slice(4)}` : String(intl || ''));

/** كل الصيغ المحتملة لرقم في قاعدة البيانات. */
const phoneVariantsJo = (raw) => {
  const intl = normalizeJo(raw);
  if (!intl) return [];
  return [intl, localJo(intl), intl.slice(1)];
};

/** إخفاء جزء من الرقم للعرض للكاشير: 079****567 */
const maskPhone = (raw) => {
  const l = localJo(normalizeJo(raw) || raw);
  return l.length >= 10 ? `${l.slice(0, 3)}****${l.slice(-3)}` : l;
};

module.exports = { normalizeJo, localJo, phoneVariantsJo, maskPhone };
