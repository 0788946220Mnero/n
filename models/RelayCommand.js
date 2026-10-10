const mongoose = require('mongoose');

/**
 * أمر من «مستقبل أوامر المدير» يُنقل لجهاز الكاشير (الرسول).
 * المرسل يؤكّد على هاتفه، وجهاز الكاشير يستلمه (ذرّياً — جهاز واحد فقط)
 * وينفّذه باسم مستخدمه، ثم يعيد النتيجة.
 */
const relayCommandSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fromName: { type: String, default: '' },
    text: { type: String, default: '', maxlength: 300 },       // ما قاله المدير
    summary: { type: String, default: '', maxlength: 300 },    // ما سيُعلن على جهاز الكاشير
    action: { type: mongoose.Schema.Types.Mixed, required: true }, // { type, ...params }
    status: { type: String, enum: ['queued', 'running', 'done', 'failed', 'cancelled', 'expired'], default: 'queued', index: true },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedByName: { type: String, default: '' },
    device: { type: String, default: '' },
    result: { type: String, default: '', maxlength: 500 },
    expiresAt: { type: Date, required: true, index: true },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RelayCommand', relayCommandSchema);
