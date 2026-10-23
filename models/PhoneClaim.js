const mongoose = require('mongoose');

/*
  بلاغ «رقمي مسجّل من شخص آخر» أو «نسيت رمز PIN».
  يُولَّد رمز من 6 أرقام يُطبع في سجلات الخادم (Railway → Logs) ولا يُرسل للزبون؛
  يتصل الزبون بالمطعم فيقرأ له الموظف الرمز من السجلات، ثم يدخله مع PIN جديد.
  الرمز نفسه لا يُخزَّن — فقط بصمته (sha256).
*/
const phoneClaimSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    ref: { type: String, required: true }, // رقم البلاغ القصير الذي يذكره الزبون عند الاتصال
    codeHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['open', 'used', 'expired'], default: 'open', index: true },
    reason: { type: String, enum: ['taken', 'forgot'], default: 'taken' },
    note: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PhoneClaim', phoneClaimSchema);
