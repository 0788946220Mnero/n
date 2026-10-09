const mongoose = require('mongoose');

/**
 * جلسة اتصال مستخدم باللوحة (WebSocket): من أول اتصال حتى انقطاعه.
 * أساس «مراقبة موظفي السنتر»: كم ساعة كان متصلاً، ومتى انقطع، وكم مرة،
 * وكم وقتاً كانت الصفحة في الخلفية (الهاتف مقفل أو تطبيق آخر).
 *
 * endReason: logout خروج طبيعي | lost انقطع الاتصال | replaced دخل من جهاز آخر | server أُعيد تشغيل الخادم
 */
const presenceSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, default: '' },
    role: { type: String, default: '' },
    startedAt: { type: Date, required: true, index: true },
    lastSeenAt: { type: Date, required: true },
    endedAt: { type: Date, default: null, index: true },
    endReason: { type: String, default: '' },
    awayMs: { type: Number, default: 0 },          // مجموع وقت الخلفية
    awaySince: { type: Date, default: null },
    device: { type: String, default: '' },         // وصف مختصر للجهاز/المتصفح
  },
  { timestamps: true }
);

presenceSessionSchema.index({ user: 1, startedAt: -1 });

module.exports = mongoose.model('PresenceSession', presenceSessionSchema);
