const mongoose = require('mongoose');

/*
  ملف الزبون في الدردشة (منصة الزبائن): اسمه الظاهر وصورته الشخصية وعدد طلباته (للإطار/الوسم).
  منفصل عن PhoneUser (مصادقة) وعن Customer (سجل الطلبات في لوحة التحكم).
  رقم الهاتف لا يظهر أبداً للزبائن الآخرين — للطاقم فقط.
*/
const profileSchema = new mongoose.Schema(
  {
    phoneUser: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneUser', required: true, unique: true, index: true },
    phone: { type: String, required: true, index: true },
    displayName: { type: String, default: '', trim: true, maxlength: 30 },
    avatar: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerMedia', default: null },
    // عدد الطلبات المكتملة (مخبّأ — يُحدَّث كل 10 دقائق عند نشاط الزبون)
    orderCount: { type: Number, default: 0 },
    orderCountAt: { type: Date, default: null },
    // الدردشة العامة: حظر من الكتابة (يقرأ فقط) — until فارغ مع banned = دائم
    communityBan: {
      banned: { type: Boolean, default: false },
      until: { type: Date, default: null },
      reason: { type: String, default: '' },
      byName: { type: String, default: '' },
      at: { type: Date, default: null },
    },
    communityMessages: { type: Number, default: 0 },
    lastCommunityAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CustomerProfile', profileSchema);
