const mongoose = require('mongoose');

/**
 * مصروف: مبلغ يخرج من صندوق الكاشير (مشتريات، أجرة توصيل، صيانة…).
 * يُنسب لمن سجّله ويدخل جرده هو وحده، ويُطبع له سند صرف.
 *
 * لا يُحذف أبداً: الخطأ يُلغى (voided) فيبقى أثره للمراجعة
 * ويخرج من الحساب — وبعد إغلاق الجرد لا يُلغى.
 */
const expenseSchema = new mongoose.Schema(
  {
    number: { type: Number, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 0.001, max: 100000 },
    brand: { type: String, default: 'diyar' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdByName: { type: String, default: '' },

    voided: { type: Boolean, default: false },
    voidedByName: { type: String, default: '' },
    voidedAt: { type: Date, default: null },

    // الجرد: يُؤرشف مع طلبات صاحبه عند إغلاق جرده
    closed: { type: Boolean, default: false, index: true },
    closedAt: { type: Date, default: null },
    shiftId: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Expense', expenseSchema);
