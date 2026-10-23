const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { wrapAll } = require('../utils/asyncHandler');
const { normalizeJo, localJo } = require('../utils/phone');
const PhoneUser = require('../models/PhoneUser');
const PhoneClaim = require('../models/PhoneClaim');

/*
  ═══════════════════════════════════════════════════════════════
  دخول زبائن الموقع: رقم الهاتف + رمز PIN (بلا رسائل تحقق SMS).

    POST /api/auth/pin/status   { phone }             → هل الرقم مسجّل؟ وهل له PIN؟
    POST /api/auth/pin/login    { phone, pin }        → إنشاء الحساب / ضبط PIN أول مرة / الدخول
    POST /api/auth/pin/report   { phone, reason }     → «رقمي مستخدم» أو «نسيت الرمز»:
                                                        رمز من 6 أرقام يُطبع في سجلات الخادم (Railway → Logs)
                                                        ويُعاد رقم المطعم ليتصل الزبون ويطلبه
    POST /api/auth/pin/reclaim  { phone, code, pin }  → الرمز صحيح ← PIN جديد وتسقط كل جلسات من سجّل الرقم

  الحماية: PIN مخزَّن بـ scrypt، 5 محاولات خاطئة ← قفل 15 دقيقة، وحد للطلبات لكل عنوان IP.
  مسارات رمز التحقق القديمة (send-otp / verify-otp) باقية كما هي ولم تعد الواجهة تستخدمها.
  ═══════════════════════════════════════════════════════════════
*/

const SECRET = () => process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;
const PIN_RX = /^\d{4}$/;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const CLAIM_TTL_MS = () => Math.max(1, Number(process.env.PHONE_CLAIM_TTL_HOURS || 168)) * 3600 * 1000; // افتراضياً 7 أيام
const CLAIM_REUSE_MS = 10 * 60 * 1000; // بلاغ ثانٍ خلال 10 دقائق يعيد نفس البلاغ (بلا رمز جديد)
const CLAIM_MAX_ATTEMPTS = 10;

/* ─── حد الطلبات لكل IP (في الذاكرة) ─── */
const hits = new Map(); // key → [timestamps]
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) { const fresh = list.filter((t) => now - t < 3600 * 1000); if (fresh.length) hits.set(k, fresh); else hits.delete(k); }
}, 10 * 60 * 1000).unref();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  return false;
}
// req.ip يحترم «trust proxy» في server.js — لا نقرأ X-Forwarded-For مباشرة (يمكن تزويره لتجاوز الحد)
const ipOf = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || '');

/* ─── PIN ─── */
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
function pinMatches(pin, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'); const b = crypto.scryptSync(String(pin), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** رموز سهلة التخمين نرفضها عند الإنشاء فقط (لا عند الدخول). */
function weakPin(pin) {
  if (/^(\d)\1{3}$/.test(pin)) return true; // 0000 1111 …
  return ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321', '3210'].includes(pin);
}
const codeHash = (code) => crypto.createHash('sha256').update(`diyar-claim:${code}`).digest('hex');

const signToken = (user) => jwt.sign({ id: String(user._id), type: 'customer', v: user.tokenVersion || 0 }, SECRET(), {
  expiresIn: process.env.CUSTOMER_JWT_EXPIRES_IN || '90d',
});
const publicUser = (u) => ({ id: u._id, phone: u.phone, isPhoneVerified: !!u.isPhoneVerified, createdAt: u.createdAt, lastLogin: u.lastLogin });
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const minutesLeft = (d) => Math.max(1, Math.ceil((new Date(d).getTime() - Date.now()) / 60000));

async function callPhone() {
  if (process.env.PHONE_CLAIM_CALL_NUMBER) return String(process.env.PHONE_CLAIM_CALL_NUMBER);
  try {
    const s = await require('../models/Setting').findOne().lean();
    const list = ((s && s.phones) || []).map((p) => String(p || '').trim()).filter(Boolean);
    return list[0] || (s && s.whatsapp) || '';
  } catch (_) { return ''; }
}

/* ─── POST /api/auth/pin/status ─── */
const status = async (req, res) => {
  const phone = normalizeJo(req.body && req.body.phone);
  if (!phone) return bad(res, 400, 'رقم الهاتف غير صالح، مثال: 0791234567');
  if (limited(`st:${ipOf(req)}`, 40, 60 * 1000)) return bad(res, 429, 'محاولات كثيرة، انتظر دقيقة ثم أعد المحاولة');
  const u = await PhoneUser.findOne({ phone }).select('+pinHash').lean();
  res.json({
    success: true,
    phone,
    exists: !!u,
    hasPin: !!(u && u.pinHash),
    lockedMinutes: u && u.pinLockedUntil && new Date(u.pinLockedUntil) > new Date() ? minutesLeft(u.pinLockedUntil) : 0,
  });
};

/* ─── POST /api/auth/pin/login ─── */
const login = async (req, res) => {
  const phone = normalizeJo(req.body && req.body.phone);
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!phone) return bad(res, 400, 'رقم الهاتف غير صالح، مثال: 0791234567');
  if (!PIN_RX.test(pin)) return bad(res, 400, 'رمز PIN يتكوّن من 4 أرقام');
  if (limited(`lg:${ipOf(req)}`, 30, 10 * 60 * 1000)) return bad(res, 429, 'محاولات كثيرة من هذا الجهاز، انتظر قليلاً ثم أعد المحاولة');

  let user = await PhoneUser.findOne({ phone }).select('+pinHash');
  const now = new Date();

  // رقم جديد ← حساب جديد بهذا الرمز
  if (!user) {
    if (weakPin(pin)) return bad(res, 400, 'هذا الرمز سهل التخمين — اختر 4 أرقام أخرى', { code: 'weak_pin' });
    try {
      user = await PhoneUser.create({ phone, pinHash: hashPin(pin), pinSetAt: now, lastLogin: now });
    } catch (e) {
      if (!(e && e.code === 11000)) throw e;
      return bad(res, 409, 'سُجّل هذا الرقم للتو — أدخل رمز PIN الخاص به', { code: 'exists' });
    }
    return res.json({ success: true, isNewUser: true, pinCreated: true, token: signToken(user), user: publicUser(user) });
  }

  // حساب قديم (من أيام رمز التحقق) بلا PIN ← أول دخول يضبطه
  if (!user.pinHash) {
    if (weakPin(pin)) return bad(res, 400, 'هذا الرمز سهل التخمين — اختر 4 أرقام أخرى', { code: 'weak_pin' });
    await PhoneUser.updateOne({ _id: user._id }, { $set: { pinHash: hashPin(pin), pinSetAt: now, pinFails: 0, pinLockedUntil: null, lastLogin: now } });
    user.lastLogin = now;
    return res.json({ success: true, isNewUser: false, pinCreated: true, token: signToken(user), user: publicUser(user) });
  }

  if (user.pinLockedUntil && new Date(user.pinLockedUntil) > now) {
    return bad(res, 423, `الدخول لهذا الرقم موقوف ${minutesLeft(user.pinLockedUntil)} دقيقة بعد محاولات خاطئة. إن نسيت الرمز اطلب رمز الاستعادة`, { code: 'locked' });
  }
  if (!pinMatches(pin, user.pinHash)) {
    const fails = (user.pinFails || 0) + 1;
    if (fails >= MAX_FAILS) {
      await PhoneUser.updateOne({ _id: user._id }, { $set: { pinFails: 0, pinLockedUntil: new Date(Date.now() + LOCK_MS) } });
      return bad(res, 423, 'رمز PIN غير صحيح — أُوقف الدخول لهذا الرقم 15 دقيقة. إن نسيت الرمز اطلب رمز الاستعادة', { code: 'locked' });
    }
    await PhoneUser.updateOne({ _id: user._id }, { $set: { pinFails: fails } });
    return bad(res, 401, `رمز PIN غير صحيح (تبقّى ${MAX_FAILS - fails} ${MAX_FAILS - fails === 1 ? 'محاولة' : 'محاولات'})`, { code: 'wrong_pin', left: MAX_FAILS - fails });
  }
  await PhoneUser.updateOne({ _id: user._id }, { $set: { pinFails: 0, pinLockedUntil: null, lastLogin: now } });
  user.lastLogin = now;
  res.json({ success: true, isNewUser: false, token: signToken(user), user: publicUser(user) });
};

/* ─── POST /api/auth/pin/report ─── */
const report = async (req, res) => {
  const phone = normalizeJo(req.body && req.body.phone);
  if (!phone) return bad(res, 400, 'رقم الهاتف غير صالح، مثال: 0791234567');
  const reason = (req.body && req.body.reason) === 'forgot' ? 'forgot' : 'taken';
  const note = String((req.body && req.body.note) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  const ip = ipOf(req);
  if (limited(`rp:${ip}`, 6, 3600 * 1000)) return bad(res, 429, 'أرسلت بلاغات كثيرة — اتصل بالمطعم مباشرة');

  const user = await PhoneUser.findOne({ phone }).select('+pinHash').lean();
  if (!user || !user.pinHash) {
    return bad(res, 404, 'هذا الرقم غير مسجّل برمز PIN بعد — يمكنك الدخول به وإنشاء رمزك مباشرة', { code: 'free' });
  }
  const call = await callPhone();
  const now = Date.now();

  // بلاغ مفتوح حديث لنفس الرقم: لا نولّد رمزاً جديداً (يبقى الرمز الذي في السجلات صالحاً)
  const recent = await PhoneClaim.findOne({ phone, status: 'open', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
  if (recent && now - new Date(recent.createdAt).getTime() < CLAIM_REUSE_MS) {
    return res.json({ success: true, ref: recent.ref, expiresAt: recent.expiresAt, callPhone: call, reused: true });
  }
  await PhoneClaim.updateMany({ phone, status: 'open' }, { $set: { status: 'expired' } });

  const code = String(crypto.randomInt(100000, 1000000));
  const ref = String(crypto.randomInt(1000, 10000));
  const expiresAt = new Date(now + CLAIM_TTL_MS());
  await PhoneClaim.create({ phone, ref, codeHash: codeHash(code), reason, note, expiresAt, ip });

  // ← يظهر في Railway → Deployments → View Logs (ابحث عن PHONE-CLAIM أو رقم الزبون)
  const until = expiresAt.toLocaleString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman', dateStyle: 'short', timeStyle: 'short' });
  console.log(`🔐 [PHONE-CLAIM] بلاغ #${ref} — الرقم ${localJo(phone)} — ${reason === 'forgot' ? 'نسي رمز PIN' : 'الرقم مسجّل من شخص آخر'} — رمز الاستعادة: ${code} — صالح حتى ${until}${note ? ` — ملاحظة: ${note}` : ''}`);

  res.json({ success: true, ref, expiresAt, callPhone: call });
};

/* ─── POST /api/auth/pin/reclaim ─── */
const reclaim = async (req, res) => {
  const phone = normalizeJo(req.body && req.body.phone);
  const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!phone) return bad(res, 400, 'رقم الهاتف غير صالح');
  if (!/^\d{6}$/.test(code)) return bad(res, 400, 'رمز الاستعادة يتكوّن من 6 أرقام');
  if (!PIN_RX.test(pin)) return bad(res, 400, 'رمز PIN الجديد يتكوّن من 4 أرقام');
  if (weakPin(pin)) return bad(res, 400, 'هذا الرمز سهل التخمين — اختر 4 أرقام أخرى', { code: 'weak_pin' });
  if (limited(`rc:${ipOf(req)}`, 15, 3600 * 1000)) return bad(res, 429, 'محاولات كثيرة — انتظر قليلاً أو اتصل بالمطعم');

  const claim = await PhoneClaim.findOne({ phone, status: 'open', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).select('+codeHash');
  if (!claim) return bad(res, 400, 'لا يوجد بلاغ مفتوح لهذا الرقم أو انتهت صلاحية الرمز — أرسل بلاغاً جديداً', { code: 'no_claim' });
  if (claim.codeHash !== codeHash(code)) {
    const attempts = (claim.attempts || 0) + 1;
    await PhoneClaim.updateOne({ _id: claim._id }, { $set: attempts >= CLAIM_MAX_ATTEMPTS ? { attempts, status: 'expired' } : { attempts } });
    return bad(res, 400, attempts >= CLAIM_MAX_ATTEMPTS ? 'محاولات خاطئة كثيرة — أُلغي البلاغ، أرسل بلاغاً جديداً' : 'رمز الاستعادة غير صحيح', { code: 'wrong_code' });
  }

  const now = new Date();
  await PhoneClaim.updateOne({ _id: claim._id }, { $set: { status: 'used', usedAt: now } });
  let user = await PhoneUser.findOne({ phone });
  if (!user) user = await PhoneUser.create({ phone, pinHash: hashPin(pin), pinSetAt: now, lastLogin: now, reclaimedAt: now, tokenVersion: 1 });
  else {
    await PhoneUser.updateOne({ _id: user._id }, {
      $set: { pinHash: hashPin(pin), pinSetAt: now, pinFails: 0, pinLockedUntil: null, lastLogin: now, reclaimedAt: now },
      $inc: { tokenVersion: 1 },
    });
    user = await PhoneUser.findById(user._id);
  }
  // من كان مسجّلاً بالرقم يخرج فوراً من الدردشة المفتوحة أيضاً
  try { require('../services/customerRealtime').disconnectCustomer(user._id); } catch (_) { /* */ }
  console.log(`🔐 [PHONE-CLAIM] بلاغ #${claim.ref} — استُعيد الرقم ${localJo(phone)} وضُبط رمز PIN جديد (أُخرجت الجلسات السابقة)`);
  res.json({ success: true, token: signToken(user), user: publicUser(user) });
};

module.exports = wrapAll({ status, login, report, reclaim });
module.exports._test = { hashPin, pinMatches, weakPin, signToken };
