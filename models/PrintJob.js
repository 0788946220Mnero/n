const mongoose = require('mongoose');

/**
 * مهمة طباعة عن بُعد: مستخدم على جهاز بلا طابعة (جوال مثلاً) يطلب طباعة،
 * وجهاز الكاشير الذي يشغّل DiyarPOS يحجزها وينفّذها بنفس توزيع الطباعة.
 *
 * دورة الحياة: pending ← claimed ← done | failed
 *                pending ← expired (لم يحجزها أحد خلال المهلة)
 *
 * الحجز ذرّي (شرط status:'pending' داخل الاستعلام)، فلو كان هناك أكثر من
 * جهاز كاشير تُطبع المهمة مرة واحدة فقط.
 */
const printJobSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['confirm', 'invoice', 'shift', 'drawer', 'expense', 'pos'],
      required: true,
    },
    // confirm/invoice: الطلب المطلوب طباعته
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    // shift: ملخص الجرد ورقمه كما أعادهما الإغلاق | expense: نسخة السند من القاعدة
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    // فتح درج النقود مع هذه الطباعة
    openDrawer: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['pending', 'claimed', 'done', 'failed', 'expired'],
      default: 'pending',
      index: true,
    },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByName: { type: String, default: '' },
    claimedBy: { type: String, default: '' },
    claimedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    error: { type: String, default: '' },

    // بعدها لا تُطبع: جهاز كاشير يُشغَّل صباحاً لا يُخرج أوامر الأمس
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// سجلّ قصير: تُحذف المهام تلقائياً بعد 7 أيام
printJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.model('PrintJob', printJobSchema);
