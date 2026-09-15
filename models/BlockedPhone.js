const mongoose = require('mongoose');

// أرقام الهواتف المحظورة من الطلب (لمنع الطلبات الوهمية / المسيئة)
const blockedPhoneSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    reason: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BlockedPhone', blockedPhoneSchema);
