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

// صور فاتورة المورّد الورقية (حتى 4 صفحات):
//   photos       الأصل للعرض بجودة كاملة — على سحابة الصور (أو Cloudinary إن سُمح)، برابط غير قابل للتخمين
//   printImages  نسخة الطباعة الحرارية: أبيض/أسود معالجة كالماسح (548px)، محفوظة مع الفاتورة نفسها
//                فتُطبع بلا إنترنت وبلا تحميل — select:false فلا تُرسل في القوائم
const photoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true, maxlength: 500 },
    storage: { type: String, default: '' },     // imagecloud | cloudinary
    fileId: { type: String, default: '' },      // معرّفها في التخزين (للحذف لاحقاً)
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    addedByName: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
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
    photos: { type: [photoSchema], default: [] },
    printImages: { type: [String], default: [], select: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdByName: { type: String, default: '' },

    status: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid', index: true },
    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    paidByName: { type: String, default: '' },
    paymentMethod: { type: String, enum: ['cash', 'cliq', 'card', ''], default: '' },
    // من أين خرج المال: drawer صندوق مستخدم (يدخل جرده) | capital رأس المال (لا يدخل أي جرد)
    // السجلات القديمة بلا هذا الحقل = صندوق من سدّد
    paySource: { type: String, enum: ['drawer', 'capital', ''], default: '' },
    drawerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    drawerUserName: { type: String, default: '' },
    capitalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'CapitalEntry', default: null },

    // التسديد يدخل جرد من سدّد (مال خارج)، ويُؤرشف عند إغلاق جرده (كالمصروف)
    collectionClosed: { type: Boolean, default: false, index: true },
    collectionShiftId: { type: String, default: '' },

    // صُدِّرت من «الالتزامات الثابتة»: متبقي دورة لم يُسدَّد حتى موعدها
    obligation: { type: mongoose.Schema.Types.ObjectId, ref: 'FixedObligation', default: null },
    obligationCycle: { type: mongoose.Schema.Types.ObjectId, ref: 'ObligationCycle', default: null },

    // الإزالة: أرشفة لا حذف — لمدير النظام وحده
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

receivableSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Receivable', receivableSchema);
