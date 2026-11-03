const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * تنبيه من إدارة البراق للسائقين أو المتاجر (يدوي):
 *   audience: drivers | stores | all — لكل السائقين/المتاجر
 *   أو recipients: أشخاص بعينهم ({ kind, id })
 * يصل لحظياً للتطبيق المفتوح، وإشعاراً على الجوال، ويبقى في «التنبيهات» داخل التطبيق.
 */
const schema = new Schema(
  {
    audience: { type: String, enum: ['drivers', 'stores', 'all', 'some'], required: true, index: true },
    recipients: [{ kind: { type: String, enum: ['driver', 'store'] }, id: { type: Schema.Types.ObjectId } }],
    title: { type: String, required: true, maxlength: 80 },
    body: { type: String, default: '', maxlength: 600 },
    urgent: { type: Boolean, default: false },
    by: { type: Schema.Types.ObjectId, default: null },
    byName: { type: String, default: '' },
    reached: { online: { type: Number, default: 0 }, push: { type: Number, default: 0 }, total: { type: Number, default: 0 } },
  },
  { timestamps: true }
);
schema.index({ createdAt: -1 });

module.exports = mongoose.models.BrqNotice || mongoose.model('BrqNotice', schema);
