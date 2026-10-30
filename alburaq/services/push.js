/**
 * إشعارات FCM — نفس المشروع والمتغيرات المستخدمة في البراق:
 *   FIREBASE_PROJECT_ID · FIREBASE_CLIENT_EMAIL · FIREBASE_PRIVATE_KEY
 * الإرسال يتم للأجهزة غير المتصلة بالتطبيق الآن. الرموز الميتة تُحذف من السائق.
 */
let admin = null;
let state = 'idle'; // idle | ready | off

function init() {
  if (state !== 'idle') return state === 'ready' ? admin : null;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) { state = 'off'; return null; }
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
    state = 'ready';
    return admin;
  } catch (err) {
    console.error('⚠️ تعذّر تهيئة Firebase Admin:', err.message);
    state = 'off';
    return null;
  }
}

const DEAD = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

/**
 * يرسل لمجموعة رموز (حتى 500 في الدفعة) ويعيد الرموز الميتة لتُحذف.
 *
 * رسالة «بيانات» فقط بأولوية عالية: تطبيق السائق (أندرويد) يستقبلها دائماً — حتى والشاشة مقفلة
 * أو التطبيق مغلق — ويعرضها بنفسه (عرض الطلب = إشعار ملء الشاشة بصوت إنذار يوقظ الشاشة).
 * والمتصفح يعرض webpush.notification (صفحة الديليفري المثبتة على الشاشة الرئيسية).
 *   urgent: عرض طلب — أولوية قصوى وصلاحية قصيرة (لا فائدة من وصوله بعد انتهاء المهلة)
 */
async function sendToTokens(tokens, { title, body, data = {}, urgent = false, ttlSec = null, tag = '' }) {
  const fb = init();
  if (!fb || !tokens.length) return { sent: 0, failed: 0, invalidTokens: [] };
  const invalidTokens = [];
  let sent = 0, failed = 0;
  const payload = Object.fromEntries(Object.entries({ ...data, title, body }).map(([k, v]) => [k, String(v ?? '')]));
  const ttl = ttlSec ? Math.max(1, Math.round(ttlSec)) : null;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const res = await fb.messaging().sendEachForMulticast({
        tokens: batch,
        data: payload,
        android: { priority: 'high', ...(ttl ? { ttl: ttl * 1000 } : {}) },
        webpush: {
          headers: { Urgency: 'high', ...(ttl ? { TTL: String(ttl) } : {}) },
          notification: {
            title, body, dir: 'rtl', lang: 'ar', icon: 'shared/logo.png', badge: 'shared/logo.png',
            tag: tag || payload.kind || 'brq', renotify: true, requireInteraction: !!urgent,
            vibrate: urgent ? [600, 200, 600, 200, 600, 200, 600] : [200, 100, 200],
          },
          fcmOptions: { link: payload.link || './' },
        },
      });
      res.responses.forEach((r, idx) => {
        if (r.success) sent++;
        else { failed++; if (DEAD.includes(r.error && r.error.code)) invalidTokens.push(batch[idx]); }
      });
    } catch (err) {
      console.error('sendToTokens:', err.message);
      failed += batch.length;
    }
  }
  return { sent, failed, invalidTokens };
}

module.exports = { sendToTokens, init };
