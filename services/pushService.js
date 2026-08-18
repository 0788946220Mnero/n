/**
 * إرسال إشعارات FCM لأجهزة الإدارة.
 *
 * لا يعمل إلا عند ضبط بيانات اعتماد Firebase في متغيّرات البيئة.
 * إن لم تُضبط، تُسجَّل رسالة في السجلات ولا يتعطّل أي شيء
 * (إنشاء الطلبات يستمر طبيعياً — الإشعار إضافة لا شرط).
 *
 * المتغيّرات المطلوبة في Railway:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (مع \n داخل النص)
 */

let admin = null;
let initialized = false;
let initFailed = false;

const initFirebase = () => {
  if (initialized || initFailed) return admin;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.log('ℹ️ إشعارات FCM غير مفعّلة (متغيّرات Firebase غير مضبوطة).');
    initFailed = true;
    return null;
  }

  try {
    // Railway يحفظ \n كنص — نعيدها أسطراً حقيقية
    privateKey = privateKey.replace(/\\n/g, '\n');

    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    }
    initialized = true;
    console.log('✅ Firebase Admin جاهز — إشعارات FCM مفعّلة.');
    return admin;
  } catch (err) {
    console.error('⚠️ تعذّر تهيئة Firebase Admin:', err.message);
    initFailed = true;
    return null;
  }
};

const isEnabled = () => {
  initFirebase();
  return initialized;
};

/**
 * إرسال إشعار لمجموعة رموز أجهزة.
 * @returns {Promise<{sent:number, failed:number, invalidTokens:string[]}>}
 */
const sendToTokens = async (tokens, { title, body, data = {} }) => {
  const fb = initFirebase();
  if (!fb || !tokens.length) return { sent: 0, failed: 0, invalidTokens: [] };

  const message = {
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: {
      priority: 'high',
      notification: { channelId: 'orders_channel', sound: 'default' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };

  try {
    const res = await fb.messaging().sendEachForMulticast({ ...message, tokens });
    const invalidTokens = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          invalidTokens.push(tokens[i]);
        }
      }
    });
    return { sent: res.successCount, failed: res.failureCount, invalidTokens };
  } catch (err) {
    console.error('sendToTokens error:', err.message);
    return { sent: 0, failed: tokens.length, invalidTokens: [] };
  }
};

/**
 * إشعار بطلب جديد — يُرسَل فقط لأصحاب صلاحية مشاهدة الطلبات.
 * الأدوار المسموح لها: admin, manager, cashier, employee (كلها ترى الطلبات).
 */
const notifyNewOrder = async (order) => {
  if (!isEnabled()) return;

  try {
    const Device = require('../models/Device');
    const User = require('../models/User');

    // من يملك صلاحية مشاهدة الطلبات فقط
    const allowedRoles = ['admin', 'manager', 'cashier', 'employee'];
    const users = await User.find({ role: { $in: allowedRoles }, isActive: true }).select('_id');
    const userIds = users.map((u) => u._id);

    const devices = await Device.find({ user: { $in: userIds }, isActive: true }).select('fcmToken');
    const tokens = [...new Set(devices.map((d) => d.fcmToken).filter(Boolean))];
    if (!tokens.length) return;

    const isDelivery = (order.orderType || 'delivery') !== 'pickup';
    const title = isDelivery ? '🚗 طلب توصيل جديد' : '🏪 طلب استلام جديد';
    const body = `الطلب #${order.orderNumber} — الإجمالي: ${Number(order.total || 0).toFixed(2)} د.أ`;

    const result = await sendToTokens(tokens, {
      title,
      body,
      data: {
        type: 'order.created',
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        orderType: order.orderType || 'delivery',
        total: order.total,
      },
    });

    // تنظيف الرموز غير الصالحة
    if (result.invalidTokens.length) {
      await Device.updateMany(
        { fcmToken: { $in: result.invalidTokens } },
        { $set: { isActive: false } }
      );
    }
    console.log(`🔔 إشعار الطلب #${order.orderNumber}: أُرسل ${result.sent} / فشل ${result.failed}`);
  } catch (err) {
    console.error('notifyNewOrder error:', err.message);
  }
};

module.exports = { isEnabled, sendToTokens, notifyNewOrder };
