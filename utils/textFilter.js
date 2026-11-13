/**
 * فلترة نصوص الدردشة العامة (والأسماء فيها):
 *  • كلمات ممنوعة يحددها فريق العمل — تُطابق بعد «تطبيع» العربية حتى لا يُتحايل عليها
 *    بالتشكيل أو التطويل أو تكرار الحروف أو الفصل بالنقاط: «حــمـاار» و«ح.م.ا.ر» = «حمار».
 *  • منع الروابط وأرقام الهواتف (اختياري من الإعدادات) — أكثر أشكال الإزعاج والاحتيال.
 */
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // محارف خفية
    .replace(/[ً-ٰٟۖ-ۭ]/g, '') // التشكيل
    .replace(/ـ/g, '') // التطويل
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]);
}
/** حروف وأرقام فقط، والحرف المكرر مرة واحدة. */
const squash = (s) => normalize(s).replace(/[^\p{L}\p{N}]+/gu, '').replace(/(.)\1+/gu, '$1');
const words = (s) => normalize(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/(.)\1+/gu, '$1'));

const LINK_RX = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|bit\.ly\/|\b[a-z0-9][a-z0-9-]{0,62}\.(com|net|org|io|me|co|jo|info|link|ly|app|xyz|site|online|store|shop|top|click|live)\b)/i;

/** يرجع { ok: true } أو { ok: false, reason: 'words'|'link'|'phone', message }. */
function check(text, settings = {}) {
  const raw = String(text || '');
  const list = (settings.blockedWords || []).map((w) => String(w || '').trim()).filter(Boolean);
  if (list.length) {
    const ws = new Set(words(raw));
    const sq = squash(raw);
    for (const w of list) {
      const nw = squash(w);
      if (!nw) continue;
      // كلمة كاملة دائماً؛ وداخل النص الملتصق للكلمات الطويلة فقط (تفادياً لمطابقة جزء من كلمة بريئة)
      if (ws.has(nw) || (nw.length >= 4 && sq.includes(nw))) {
        return { ok: false, reason: 'words', message: 'رسالتك تحتوي كلمات غير مسموحة في الدردشة العامة' };
      }
    }
  }
  const n = normalize(raw);
  if (settings.blockLinks && LINK_RX.test(n)) {
    return { ok: false, reason: 'link', message: 'الروابط غير مسموحة في الدردشة العامة' };
  }
  if (settings.blockPhones) {
    const digits = n.replace(/[\s\-–.()/]+/g, '');
    if (/\+?\d{7,}/.test(digits)) return { ok: false, reason: 'phone', message: 'أرقام الهواتف غير مسموحة في الدردشة العامة — للتواصل الخاص استخدم «تواصل مع فريق العمل»' };
  }
  return { ok: true };
}

module.exports = { normalize, squash, words, check };
