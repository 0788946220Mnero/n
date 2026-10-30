const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const PIN_RE = /^\d{4,6}$/;
const OTP_RE = /^\d{12}$/;
const PHONE_RE = /^\+?\d{8,15}$/;

/** توحيد صيغة الرقم: إزالة الفراغات والرموز، وتحويل 00 إلى +. يرجع null إن كان غير صالح. */
function normalizePhone(raw) {
  let s = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return PHONE_RE.test(s) ? s : null;
}

const isValidPin = (pin) => PIN_RE.test(String(pin || ''));
const isValidOtpFormat = (otp) => OTP_RE.test(String(otp || ''));

/**
 * رمز OTP طويل من 12 رقماً بتوزيع متساوٍ (بدون انحياز الباقي).
 * البايت 250..255 يُرفض لأن 250 = 25 × 10.
 */
function generateOtp(digits = 12) {
  let out = '';
  while (out.length < digits) {
    const b = crypto.randomBytes(1)[0];
    if (b < 250) out += String(b % 10);
  }
  return out;
}

const hashSecret = (secret) => bcrypt.hash(String(secret), 10);
const compareSecret = (secret, hash) =>
  hash ? bcrypt.compare(String(secret), hash) : Promise.resolve(false);

/** مقارنة ثابتة الزمن لكلمة مرور الأدمن (نقارن هاشين بطول ثابت). */
function safeEqualSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

module.exports = {
  normalizePhone,
  isValidPin,
  isValidOtpFormat,
  generateOtp,
  hashSecret,
  compareSecret,
  safeEqualSecret,
};
