const mongoose = require('mongoose');

/**
 * اشتراك جهاز في «التقرير الحي على شاشة القفل» (Web Push).
 * جهاز واحد = endpoint واحد. يُحذف تلقائياً إن أبلغ المتصفح أنه لم يعد صالحاً.
 */
const liveReportSubSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, default: '' },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    ua: { type: String, default: '' },
    lastOkAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LiveReportSub', liveReportSubSchema);
