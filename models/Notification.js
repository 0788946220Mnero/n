const mongoose = require('mongoose');

/*
  ═══════════════════════════════════════════════════════════════
  الإشعار — يُكتب يدوياً من لوحة التحكم ويُرسل للزبائن.

  قناتان معاً لتغطية الجميع:
    • Push عبر FCM  → أندرويد وكروم، والآيفون المُثبَّت على الشاشة الرئيسية
    • داخل الموقع   → شريط يظهر لأي زبون يفتح الموقع خلال مدة الصلاحية،
                      وهو ما يغطّي مستخدمي الآيفون الذين لم يُثبّتوا الموقع
  ═══════════════════════════════════════════════════════════════
*/
const notificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    link: { type: String, default: '', trim: true }, // رابط يُفتح عند النقر (اختياري)
    image: { type: String, default: '', trim: true },

    sentToAll: { type: Boolean, default: true },

    // العرض داخل الموقع — تغطية مستخدمي الآيفون غير المُثبِّتين
    showInSite: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null, index: true },

    // حالة الإرسال
    status: {
      type: String,
      enum: ['draft', 'sent', 'failed'],
      default: 'draft',
      index: true,
    },
    sentAt: { type: Date, default: null },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // إحصائيات الإرسال
    pushSent: { type: Number, default: 0 },
    pushFailed: { type: Number, default: 0 },
    pushError: { type: String, default: '' },
  },
  { timestamps: true }
);

// الإشعار فعّال داخل الموقع إن أُرسل ولم تنتهِ صلاحيته
notificationSchema.statics.findActive = function findActive() {
  const now = new Date();
  return this.findOne({
    status: 'sent',
    showInSite: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort('-sentAt');
};

module.exports = mongoose.model('Notification', notificationSchema);
