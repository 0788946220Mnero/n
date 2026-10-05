const mongoose = require('mongoose');

/**
 * حركة على رأس المال. الرصيد الحالي = مجموع الحركات غير الملغاة.
 *   deposit   إيداع/زيادة رأس المال (+)
 *   withdraw  سحب يدوي (−)
 *   expense   مصروف صُرف من رأس المال (−) — مرتبط بسند الصرف
 * لا يُحذف شيء: الخطأ يُلغى ويبقى أثره.
 */
const capitalEntrySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['deposit', 'withdraw', 'expense'], required: true, index: true },
    amount: { type: Number, required: true, min: 0.001 },          // موجب دائماً؛ الإشارة من النوع
    note: { type: String, default: '', maxlength: 200 },
    date: { type: Date, default: Date.now, index: true },          // تاريخ الحركة الفعلي
    expense: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null, index: true },
    expenseNumber: { type: Number, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    voided: { type: Boolean, default: false, index: true },
    voidedAt: { type: Date, default: null },
    voidedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

/** الأثر على الرصيد: الإيداع يزيد، والسحب والمصروف ينقصان. */
capitalEntrySchema.statics.signed = (e) => (e.type === 'deposit' ? 1 : -1) * Number(e.amount || 0);

module.exports = mongoose.model('CapitalEntry', capitalEntrySchema);
