/*
  ═══════════════════════════════════════════════════════════════
  مزود إرسال رموز التحقق OTP — قابل للتبديل عبر متغير البيئة:

      OTP_PROVIDER=dev      → وضع التطوير (يطبع الرمز في اللوج، بدون رسائل SMS حقيقية)
      OTP_PROVIDER=twilio   → Twilio Verify (يحتاج TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID)
      OTP_PROVIDER=firebase → Firebase (التحقق يتم في الواجهة عبر Firebase JS SDK،
                              والباك اند يتحقق من الـ idToken عبر firebase-admin)

  كل مزود يطبّق نفس الواجهة: sendCode(phone) و verifyCode(phone, code)
  فالتبديل بينهم لا يحتاج أي تعديل على الـ Controllers.
  ═══════════════════════════════════════════════════════════════
*/

const crypto = require('crypto');

/* ─────────── مزود التطوير (Dev) — افتراضي وآمن للتجربة ───────────
   يولّد رمزاً من 6 أرقام ويخزّنه بالذاكرة لمدة 5 دقائق ويطبعه في اللوج. */
const devStore = new Map(); // phone → { hash, expiresAt, attempts }

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

const devProvider = {
  async sendCode(phone) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    devStore.set(phone, { hash: hashCode(code), expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 });
    console.log(`📲 [DEV OTP] الرمز لرقم ${phone} هو: ${code}`);
    return { success: true };
  },
  async verifyCode(phone, code) {
    const entry = devStore.get(phone);
    if (!entry) return { success: false, message: 'لم يتم إرسال رمز لهذا الرقم' };
    if (Date.now() > entry.expiresAt) { devStore.delete(phone); return { success: false, message: 'انتهت صلاحية الرمز، أعد الإرسال' }; }
    entry.attempts += 1;
    if (entry.attempts > 5) { devStore.delete(phone); return { success: false, message: 'محاولات كثيرة خاطئة، أعد إرسال الرمز' }; }
    if (entry.hash !== hashCode(code)) return { success: false, message: 'الرمز غير صحيح' };
    devStore.delete(phone);
    return { success: true };
  },
};

/* ─────────── Twilio Verify ─────────── */
const twilioProvider = {
  _client: null,
  _getClient() {
    if (!this._client) {
      // require كسول: لا يفشل السيرفر إذا لم تكن مكتبة twilio مثبتة والمزود غير مستخدم
      const twilio = require('twilio');
      this._client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return this._client;
  },
  async sendCode(phone) {
    try {
      await this._getClient().verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: phone, channel: 'sms' });
      return { success: true };
    } catch (err) {
      console.error('Twilio sendCode error:', err.message);
      return { success: false, message: 'تعذر إرسال رمز التحقق، تأكد من صحة الرقم' };
    }
  },
  async verifyCode(phone, code) {
    try {
      const check = await this._getClient().verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: phone, code });
      return check.status === 'approved'
        ? { success: true }
        : { success: false, message: 'الرمز غير صحيح' };
    } catch (err) {
      console.error('Twilio verifyCode error:', err.message);
      return { success: false, message: 'تعذر التحقق من الرمز' };
    }
  },
};

/* ─────────── Firebase Authentication ───────────
   مع Firebase، إرسال SMS والتحقق يتمان في المتصفح عبر Firebase JS SDK،
   والواجهة ترسل idToken الناتج إلى /verify-otp في حقل "code".
   الباك اند يتحقق من التوكن ويستخرج رقم الهاتف منه. */
const firebaseProvider = {
  _admin: null,
  _getAdmin() {
    if (!this._admin) {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
          }),
        });
      }
      this._admin = admin;
    }
    return this._admin;
  },
  async sendCode() {
    // مع Firebase الإرسال يتم من الواجهة مباشرة — الباك اند يؤكد الجاهزية فقط
    return { success: true, clientSide: true };
  },
  async verifyCode(phone, idToken) {
    try {
      const decoded = await this._getAdmin().auth().verifyIdToken(idToken);
      const tokenPhone = decoded.phone_number || '';
      return tokenPhone === phone
        ? { success: true }
        : { success: false, message: 'رقم الهاتف لا يطابق التوكن' };
    } catch (err) {
      console.error('Firebase verify error:', err.message);
      return { success: false, message: 'فشل التحقق من التوكن' };
    }
  },
};

/* ─────────── اختيار المزود ─────────── */
const providers = { dev: devProvider, twilio: twilioProvider, firebase: firebaseProvider };
const activeName = (process.env.OTP_PROVIDER || 'dev').toLowerCase();
const activeProvider = providers[activeName] || devProvider;

console.log(`🔐 OTP Provider النشط: ${activeName in providers ? activeName : 'dev (افتراضي)'}`);

module.exports = activeProvider;
