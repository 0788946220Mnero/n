const mongoose = require('mongoose');

/*
  مستخدم الموقع (زبون) — دخول برقم الهاتف ورمز PIN (بلا رسائل تحقق).
  منفصل تماماً عن موديل User الخاص بلوحة التحكم حتى لا نكسر نظام الأدمن.
  • أول دخول برقم جديد: ينشئ الزبون رمز PIN فيُنشأ الحساب.
  • الحسابات القديمة (من أيام رمز التحقق) بلا PIN: أول دخول يضبط الرمز.
  • من سجّل رقماً ليس له: صاحب الرقم يبلّغ (PhoneClaim) ويستعيده برمز من المطعم،
    فيُضبط PIN جديد ويزيد tokenVersion فتسقط كل جلسات الآخر.
*/
const phoneUserSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, trim: true, index: true },
    isPhoneVerified: { type: Boolean, default: false },
    lastLogin: { type: Date, default: null },
    // scrypt «salt:hash» — لا يُعاد في أي استعلام إلا بـ select('+pinHash')
    pinHash: { type: String, default: '', select: false },
    pinSetAt: { type: Date, default: null },
    pinFails: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },
    // يزيد عند استعادة الرقم: كل توكن قديم (v أصغر) يُرفض
    tokenVersion: { type: Number, default: 0 },
    reclaimedAt: { type: Date, default: null },
  },
  { timestamps: true } // createdAt / updatedAt تلقائياً
);

module.exports = mongoose.model('PhoneUser', phoneUserSchema);
