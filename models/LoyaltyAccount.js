const mongoose = require('mongoose');

/**
 * عضوية الولاء — واحدة لكل رقم هاتف (+9627XXXXXXXX).
 * الرصيد هنا نسخة سريعة للعرض؛ المرجع الأساسي هو سجل LoyaltyTransaction
 * (إعادة الحساب من السجل متاحة للإدارة). لا يُعدَّل الرصيد إلا من loyaltyService.
 */
const loyaltyAccountSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, trim: true },
    name: { type: String, default: '', maxlength: 80 },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    phoneUser: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneUser', default: null },
    memberNo: { type: String, required: true, unique: true },   // DY-000123 — يظهر على البطاقة
    qrCode: { type: String, required: true, unique: true },     // رمز عشوائي في QR — لا يكشف الهاتف
    balance: { type: Number, default: 0 },
    lifetimeEarned: { type: Number, default: 0 },
    lifetimeRedeemed: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
    // يزيد مع كل تغيير يظهر على البطاقة — Apple (passesUpdatedSince) وGoogle يحدّثان عنده
    passVersion: { type: Number, default: 1 },
    passUpdatedAt: { type: Date, default: Date.now },
    apple: {
      issuedAt: { type: Date, default: null },     // أول تنزيل لملف .pkpass
      registeredDevices: { type: Number, default: 0 },
      lastPushAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
      lastErrorAt: { type: Date, default: null },
    },
    google: {
      objectId: { type: String, default: '' },     // issuerId.suffix
      savedAt: { type: Date, default: null },      // أول رابط «أضف إلى Google Wallet»
      lastSyncAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
      lastErrorAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

loyaltyAccountSchema.index({ name: 1 });
loyaltyAccountSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('LoyaltyAccount', loyaltyAccountSchema);
