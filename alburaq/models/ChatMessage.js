const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * رسالة دردشة: سائقون، متاجر، والإدارة. نص أو صورة (على سيرفر الصور) أو صوت أو موقع.
 * المرسل: senderKind + sender (المعرّف) — وللإدارة: معرّف المستخدم الذي كتب.
 */
const schema = new Schema(
  {
    channel: { type: String, required: true, index: true },
    senderKind: { type: String, enum: ['driver', 'store', 'admin'], required: true },
    sender: { type: String, required: true },
    senderName: { type: String, required: true },
    kind: { type: String, enum: ['text', 'image', 'voice', 'location'], required: true },
    text: { type: String, default: '', maxlength: 1000 },
    image: { id: String, url: String, thumb: String },
    voice: { media: { type: Schema.Types.ObjectId, ref: 'BrqChatMedia' }, duration: Number, mime: String },
    location: { lat: Number, lng: Number, label: String },
    deleted: { type: Boolean, default: false },
    deletedBy: { type: String, default: '' },
  },
  { timestamps: true }
);
schema.index({ channel: 1, createdAt: -1 });

module.exports = mongoose.model('BrqChatMessage', schema, 'brq_chatmessages');
