const { wrapAll } = require('../utils/asyncHandler');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const PushSubscriber = require('../models/PushSubscriber');
const pushService = require('../services/pushService');

/* ═════════ مسارات عامة (صفحة الزبائن — بلا تسجيل دخول) ═════════ */

// POST /api/notifications/subscribe  { token, platform, standalone, phone }
const subscribe = async (req, res) => {
  const { token, platform, standalone, phone } = req.body;
  if (!token || String(token).length < 20) {
    return res.status(400).json({ success: false, message: 'رمز الجهاز غير صالح' });
  }

  await PushSubscriber.findOneAndUpdate(
    { token: String(token) },
    {
      token: String(token),
      platform: ['android', 'ios', 'web'].includes(platform) ? platform : 'web',
      standalone: !!standalone,
      phone: String(phone || ''),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      lastSeen: new Date(),
      isActive: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const count = await PushSubscriber.countDocuments({ isActive: true });
  console.log(`🔔 اشتراك جديد في إشعارات الزبائن (${platform || 'web'}) — الإجمالي: ${count}`);
  res.json({ success: true, message: 'تم تفعيل الإشعارات' });
};

// POST /api/notifications/unsubscribe  { token }
const unsubscribe = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'رمز الجهاز مطلوب' });

  await PushSubscriber.updateOne({ token: String(token) }, { $set: { isActive: false } });
  res.json({ success: true, message: 'تم إيقاف الإشعارات' });
};

// GET /api/notifications/active
// الإشعار الفعّال للعرض داخل الموقع — هذا ما يغطّي مستخدمي الآيفون
// الذين لم يُثبّتوا الموقع على الشاشة الرئيسية ولا تصلهم إشعارات Push.
const getActiveNotification = async (req, res) => {
  const notification = await Notification.findActive();
  if (!notification) return res.json({ success: true, data: null });

  res.json({
    success: true,
    data: {
      _id: notification._id,
      title: notification.title,
      message: notification.message,
      link: notification.link,
      image: notification.image,
      sentAt: notification.sentAt,
    },
  });
};

/* ═════════ مسارات لوحة التحكم ═════════ */

// GET /api/notifications — سجل الإشعارات + عدد المشتركين
const getNotifications = async (req, res) => {
  const [notifications, subscribers, iosInstalled] = await Promise.all([
    Notification.find().sort('-createdAt').limit(50).lean(),
    PushSubscriber.countDocuments({ isActive: true }),
    PushSubscriber.countDocuments({ isActive: true, platform: 'ios' }),
  ]);

  res.json({
    success: true,
    data: notifications,
    stats: { subscribers, iosInstalled },
  });
};

// POST /api/notifications — كتابة الإشعار وإرساله
// send=false يحفظه مسودة دون إرسال
const createNotification = async (req, res) => {
  const { title, message, link, image, showInSite, expiresInHours, send } = req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: 'عنوان الإشعار مطلوب' });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: 'نص الإشعار مطلوب' });
  }

  const hours = Number(expiresInHours);
  const expiresAt = Number.isFinite(hours) && hours > 0
    ? new Date(Date.now() + hours * 60 * 60 * 1000)
    : null;

  const notification = await Notification.create({
    title: String(title).trim(),
    message: String(message).trim(),
    link: String(link || '').trim(),
    image: String(image || '').trim(),
    showInSite: showInSite !== false,
    expiresAt,
    status: 'draft',
  });

  // حفظ كمسودة فقط
  if (send === false) {
    return res.status(201).json({ success: true, data: notification, message: 'تم حفظ الإشعار كمسودة' });
  }

  const result = await pushService.notifyCustomers({
    title: notification.title,
    body: notification.message,
    link: notification.link,
    image: notification.image,
  });

  // ملاحظة مهمة: فشل Push لا يعني فشل الإشعار — العرض داخل الموقع
  // يبقى فعّالاً ويصل كل زبون يفتح الموقع، وهو ما يغطّي مستخدمي الآيفون.
  notification.status = 'sent';
  notification.sentAt = new Date();
  notification.sentBy = req.user._id;
  notification.pushSent = result.sent;
  notification.pushFailed = result.failed;
  notification.pushError = result.error || '';
  await notification.save();

  console.log(`📣 ${req.user.username} أرسل إشعاراً: "${notification.title}" — Push: ${result.sent}`);

  res.status(201).json({
    success: true,
    data: notification,
    message: result.error
      ? `تم نشر الإشعار داخل الموقع. أما إشعارات الهاتف فلم تُرسَل: ${result.error}`
      : `تم إرسال الإشعار — وصل ${result.sent} جهاز، وسيظهر داخل الموقع لبقية الزبائن`,
  });
};

// POST /api/notifications/:id/resend — إعادة إرسال إشعار سابق
const resendNotification = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: 'معرّف الإشعار غير صالح' });
  }
  const notification = await Notification.findById(req.params.id);
  if (!notification) return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });

  const result = await pushService.notifyCustomers({
    title: notification.title,
    body: notification.message,
    link: notification.link,
    image: notification.image,
  });

  notification.status = 'sent';
  notification.sentAt = new Date();
  notification.sentBy = req.user._id;
  notification.pushSent = result.sent;
  notification.pushFailed = result.failed;
  notification.pushError = result.error || '';
  await notification.save();

  res.json({ success: true, data: notification, message: `أُعيد الإرسال — وصل ${result.sent} جهاز` });
};

// DELETE /api/notifications/:id
const deleteNotification = async (req, res) => {
  const notification = await Notification.findById(req.params.id);
  if (!notification) return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });

  await notification.deleteOne();
  console.log(`🗑️ حذف ${req.user.username} الإشعار: ${notification.title}`);
  res.json({ success: true, message: 'تم حذف الإشعار' });
};


// GET /api/notifications/diagnostics — لماذا لا تصل الإشعارات؟
// يفحص كل حلقة في السلسلة ويقول أين انقطعت بالضبط.
const getDiagnostics = async (req, res) => {
  const checks = [];
  const add = (ok, label, hint = '') => checks.push({ ok, label, hint });

  // ١) بيانات اعتماد Firebase على الخادم
  const hasProject = !!process.env.FIREBASE_PROJECT_ID;
  const hasEmail = !!process.env.FIREBASE_CLIENT_EMAIL;
  const hasKey = !!process.env.FIREBASE_PRIVATE_KEY;

  add(hasProject, 'FIREBASE_PROJECT_ID مضبوط', 'أضفه في Railway ← Variables');
  add(hasEmail, 'FIREBASE_CLIENT_EMAIL مضبوط', 'من Firebase ← Service accounts');
  add(hasKey, 'FIREBASE_PRIVATE_KEY مضبوط', 'انسخه كاملاً مع BEGIN/END');

  // المفتاح الخاص أكثر ما يُخطأ فيه: يُلصق بلا أسطر أو ناقصاً
  if (hasKey) {
    const key = process.env.FIREBASE_PRIVATE_KEY;
    const looksValid = key.includes('BEGIN PRIVATE KEY') && key.includes('END PRIVATE KEY');
    add(looksValid, 'شكل المفتاح الخاص سليم', 'يجب أن يحتوي BEGIN PRIVATE KEY و END PRIVATE KEY');
  }

  // ٢) هل تمّت تهيئة Firebase Admin فعلاً؟
  const fcmReady = pushService.isEnabled();
  add(fcmReady, 'Firebase Admin مُهيّأ في الخادم', 'راجع سجلات Railway عند الإقلاع');

  // ٣) هل هناك أجهزة مشتركة أصلاً؟
  const [total, ios, android, web, standalone] = await Promise.all([
    PushSubscriber.countDocuments({ isActive: true }),
    PushSubscriber.countDocuments({ isActive: true, platform: 'ios' }),
    PushSubscriber.countDocuments({ isActive: true, platform: 'android' }),
    PushSubscriber.countDocuments({ isActive: true, platform: 'web' }),
    PushSubscriber.countDocuments({ isActive: true, standalone: true }),
  ]);

  add(total > 0, `أجهزة مشتركة: ${total}`,
    'صفر يعني أن صفحة الزبائن لم تسجّل أي جهاز — راجع firebase-config.js وشغّل DiyarPush.diagnose() في المتصفح');

  // ٤) نتيجة آخر إرسال
  const last = await Notification.findOne({ status: 'sent' }).sort('-sentAt').lean();
  if (last) {
    add(last.pushSent > 0, `آخر إشعار "${last.title}": وصل ${last.pushSent} / فشل ${last.pushFailed}`,
      last.pushError || '');
  } else {
    add(false, 'لم يُرسل أي إشعار بعد', 'أرسل إشعاراً تجريبياً');
  }

  const blocking = checks.find((c) => !c.ok);

  res.json({
    success: true,
    ready: !blocking,
    summary: blocking
      ? `أول عائق: ${blocking.label}${blocking.hint ? ' — ' + blocking.hint : ''}`
      : 'كل شيء جاهز',
    checks,
    subscribers: { total, ios, android, web, standalone },
  });
};

// POST /api/notifications/test — إشعار تجريبي لجهاز واحد
// أسرع طريقة لإغلاق الحلقة: إن وصل هذا فالسلسلة كلها سليمة.
const sendTest = async (req, res) => {
  const { token } = req.body;

  let tokens = [];
  if (token) {
    tokens = [String(token)];
  } else {
    const latest = await PushSubscriber.findOne({ isActive: true }).sort('-lastSeen').select('token');
    if (!latest) {
      return res.status(400).json({ success: false, message: 'لا يوجد أي جهاز مشترك لإرسال تجربة إليه' });
    }
    tokens = [latest.token];
  }

  const result = await pushService.sendToTokens(tokens, {
    title: '🔔 إشعار تجريبي',
    body: 'إن وصلك هذا فنظام الإشعارات يعمل بشكل صحيح.',
    data: { kind: 'test' },
  });

  res.json({
    success: result.sent > 0,
    message: result.sent > 0
      ? 'أُرسل الإشعار التجريبي — تحقّق من هاتفك'
      : 'لم يصل الإشعار. راجع نتيجة التشخيص أعلاه.',
    result,
  });
};

module.exports = wrapAll({
  subscribe,
  getDiagnostics,
  sendTest,
  unsubscribe,
  getActiveNotification,
  getNotifications,
  createNotification,
  resendNotification,
  deleteNotification,
});
