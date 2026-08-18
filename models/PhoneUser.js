const mongoose = require('mongoose');

/*
  مستخدم الموقع (زبون) — مصادقة برقم الهاتف فقط.
  منفصل تماماً عن موديل User الخاص بلوحة التحكم حتى لا نكسر نظام الأدمن.
  يُنشأ الحساب تلقائياً عند أول تحقق OTP ناجح.
*/
const phoneUserSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, trim: true, index: true },
    isPhoneVerified: { type: Boolean, default: false },
    lastLogin: { type: Date, default: null },
  },
  { timestamps: true } // createdAt / updatedAt تلقائياً
);

module.exports = mongoose.model('PhoneUser', phoneUserSchema);
