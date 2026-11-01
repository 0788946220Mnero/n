const mongoose = require('mongoose');

/**
 * جهاز موظف مفعّل لـ«إشعارات الطاقم» (Web Push من لوحة التحكم المثبّتة على الشاشة).
 * جهاز واحد = endpoint واحد، ومستخدمه آخر من فعّله عليه. يُحذف تلقائياً إن أبلغ المتصفح أنه لم يعد صالحاً.
 */
const staffDeviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, default: '' },
    role: { type: String, default: '' },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    platform: { type: String, default: 'other' }, // ios | android | windows | mac | other
    standalone: { type: Boolean, default: false }, // مثبّتة على الشاشة الرئيسية
    ua: { type: String, default: '' },
    lastOkAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StaffDevice', staffDeviceSchema);
