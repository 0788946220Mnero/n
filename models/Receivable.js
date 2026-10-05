const mongoose = require('mongoose');

/**
 * ذمة على المطعم: فاتورة خارجية من مورّد (بضاعة/خدمة) لم يسدّدها المطعم بعد.
 *  • غير مدفوعة ← تُطبع بختم «غير مدفوع».
 *  • التسديد للمورّد (نقداً/كليك/فيزا) يُسجَّل ومن قام به، فتُطبع بختم «دُفع نقداً»…
 *    ويدخل جرد من سدّدها كمال خارج (النقدي يُطرح من الصندوق).
 *  • لا تُحذف أبداً حذفاً نهائياً، والإزالة (أرشفة) لمدير النظام وحده — يفرضها الخادم.
 * ملاحظة: الحقل customerName يحمل اسم المورّد (الاسم القديم أُبقي للتوافق مع السجلات المحفوظة).
 */
const lineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, default: 1, min: 0.001 },
    price: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const receivableSchema = new mongoose.Schema(
  {
    number: { type: Number, index: true },
    customerName: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: '', trim: true, maxlength: 20 },
    lines: { type: [lineSchema], default: [] },
    amount: { type: Number, required: true, min: 0.001, max: 1000000 },
    notes: { type: String, default: '', maxlength: 300 },
    orderNumber: { type: String, default: '' }, // (قديم) لا يُستخدم
    invoiceNumber: { type: String, default: '', trim: true, maxlength: 40 }, // رقم فاتورة المورّد

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdByName: { type: String, default: '' },

    status: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid', index: true },
    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    paidByName: { type: String, default: '' },
    paymentMethod: { type: String, enum: ['cash', 'cliq', 'card', ''], default: '' },

    // التسديد يدخل جرد من سدّد (مال خارج)، ويُؤرشف عند إغلاق جرده (كالمصروف)
    collectionClosed: { type: Boolean, default: false, index: true },
    collectionShiftId: { type: String, default: '' },

    // الإزالة: أرشفة لا حذف — لمدير النظام وحده
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

receivableSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Receivable', receivableSchema);
