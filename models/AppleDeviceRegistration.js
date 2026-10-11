const mongoose = require('mongoose');

/**
 * جهاز آيفون أضاف بطاقة ولاء إلى Apple Wallet (Apple Wallet Passes Web Service).
 * يُسجَّل عند الإضافة ويُحذف عند الإزالة؛ عند تغيّر الرصيد نرسل إشعار APNs فارغاً لرمز الجهاز،
 * فيطلب الآيفون أحدث نسخة من البطاقة.
 */
const schema = new mongoose.Schema(
  {
    deviceLibraryId: { type: String, required: true, maxlength: 200 },
    pushToken: { type: String, required: true, maxlength: 200 },
    passTypeId: { type: String, required: true, maxlength: 200 },
    serialNumber: { type: String, required: true, maxlength: 64 },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyAccount', required: true },
  },
  { timestamps: true }
);

schema.index({ deviceLibraryId: 1, passTypeId: 1, serialNumber: 1 }, { unique: true });
schema.index({ serialNumber: 1 });

module.exports = mongoose.model('AppleDeviceRegistration', schema);
