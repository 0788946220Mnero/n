const mongoose = require('mongoose');

/**
 * وسائط الدردشة (صور مضغوطة ورسائل صوتية) — محفوظة في القاعدة نفسها، خلف تسجيل الدخول:
 * لا رابط عام لها، ولا تعتمد على تشغيل جهاز الكاشير. الحجم محدود (الصورة تُضغط قبل الرفع).
 * expired ← انتهت مدة الاحتفاظ التي اختارها مدير النظام (تُمسح البيانات ويبقى السجل).
 */
const mediaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['image', 'voice'], required: true },
    mime: { type: String, required: true },
    size: { type: Number, default: 0 },
    data: { type: Buffer, select: false },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatConversation', required: true, index: true },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expired: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }, // حُذفت رسالتها «للجميع»
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatMedia', mediaSchema);
