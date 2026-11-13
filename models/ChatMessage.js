const mongoose = require('mongoose');

/**
 * رسالة في «دردشة الطاقم»: نص، صورة، رسالة صوتية، سجل مكالمة، أو رسالة نظام.
 * الحذف «للجميع» يُبقي مكانها («حُذفت هذه الرسالة») ويمسح محتواها ووسائطها.
 */
const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatConversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    senderName: { type: String, default: '' },
    kind: { type: String, enum: ['text', 'image', 'voice', 'call', 'system'], default: 'text' },
    text: { type: String, default: '', maxlength: 4000 },
    media: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMedia', default: null },
    mediaMime: { type: String, default: '' },
    mediaSize: { type: Number, default: 0 },
    duration: { type: Number, default: 0 }, // ثواني الصوت
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    call: { type: mongoose.Schema.Types.Mixed, default: null }, // { video, status: missed|rejected|answered|cancelled|busy, duration }
    replyTo: { type: mongoose.Schema.Types.Mixed, default: null }, // { _id, senderName, kind, text }
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedByName: { type: String, default: '' },
  },
  { timestamps: true }
);
messageSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', messageSchema);
