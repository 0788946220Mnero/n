const mongoose = require('mongoose');

/**
 * وسائط صوتية للدردشة — محفوظة في القاعدة نفسها خلف تسجيل الدخول (نفس أسلوب البراق):
 * لا رابط عام لها. الصور تذهب لسيرفر الصور، أما الصوت فهنا لأنه صغير ومحدود.
 */
const schema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['voice'], default: 'voice' },
    mime: { type: String, required: true },
    size: { type: Number, default: 0 },
    data: { type: Buffer, select: false },
    channel: { type: String, required: true, index: true },
    uploader: { type: String, required: true }, // d.<id> | s.<id> | admin
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqChatMedia', schema, 'brq_chatmedia');
