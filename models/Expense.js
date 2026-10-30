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
    paidTo: { type: String, default: '', trim: true, maxlength: 80 }, // «صرفنا إلى» في سند الصرف
    // مصدر التمويل: drawer صندوق الكاشير (يدخل جرده) | capital رأس المال (لا يدخل أي جرد)
    source: { type: String, enum: ['drawer', 'capital'], default: 'drawer', index: true },
    // وسيلة الدفع الفعلية — حقل مستقل عن مصدر التمويل ولا يُستنتج منه:
    //   cash نقداً | cliq كليك. '' = سند قديم قبل هذا الحقل (يُحسب نقداً كما كان يُحسب دائماً)
    paymentMethod: { type: String, enum: ['cash', 'cliq', ''], default: '', index: true },
    // الحساب الذي خرج منه المال فعلاً (يُشتق في الخادم من المصدر والوسيلة):
    //   drawer_cash نقدية الصندوق · drawer_cliq كليك الجرد · capital_cash رأس المال نقداً · capital_cliq رأس المال عبر كليك
    account: { type: String, enum: ['drawer_cash', 'drawer_cliq', 'capital_cash', 'capital_cliq', ''], default: '' },
    // تصنيف المصروف (utils/expenseCategories.js)
    category: { type: String, default: '', maxlength: 40, index: true },
    reference: { type: String, default: '', trim: true, maxlength: 80 }, // رقم مرجع/حوالة كليك/فاتورة
    notes: { type: String, default: '', trim: true, maxlength: 300 },
    // معرّف العملية من الواجهة: إعادة الإرسال بعد انقطاع أو نقرة مزدوجة لا تسجّل المصروف مرتين
    clientRef: { type: String, default: null },
    // صرف لموظف: راتب، سلفة، مكافأة… (يُحفظ في سجل الموظف)
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    employeeName: { type: String, default: '' },
    kind: { type: String, enum: ['general', 'salary', 'advance', 'bonus', 'other'], default: 'general' },
    spentAt: { type: Date, default: null }, // تاريخ الصرف الفعلي (افتراضياً لحظة التسجيل)
    // اعتماد مدير النظام لصرف الموظف: اسمه وتوقيعه منسوخان لحظة الاعتماد (إعادة الطباعة تُظهر نفس التوقيع)
    approvedByName: { type: String, default: '' },
    approvedByRole: { type: String, default: '' }, // admin = «اعتمده مدير النظام»
    approvedAt: { type: Date, default: null },
    approvedSignature: { type: String, default: '' },
    brand: { type: String, default: 'diyar' },

    // قسط يومي من «الالتزامات الثابتة»: يُطبع بختم «مدفوع» وتوقيع مدير النظام الذي اعتمد الالتزام
    obligation: { type: mongoose.Schema.Types.ObjectId, ref: 'FixedObligation', default: null, index: true },
    obligationCycle: { type: mongoose.Schema.Types.ObjectId, ref: 'ObligationCycle', default: null, index: true },
    obligationNumber: { type: Number, default: null },
    obligationDay: { type: String, default: '' }, // YYYY-MM-DD (عمّان)
    obligationDue: { type: String, default: '' }, // موعد السداد
    obligationAmount: { type: Number, default: null }, // مبلغ الدورة
    obligationRemaining: { type: Number, default: null }, // المتبقي بعد هذا القسط
    obligationDaysLeft: { type: Number, default: null }, // الأيام المتبقية بعد اليوم

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

// مصروف واحد لكل معرّف عملية (الفهرس جزئي: السندات القديمة بلا معرّف لا تتأثر)
expenseSchema.index({ clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'expense_client_ref' });

module.exports = mongoose.model('Expense', expenseSchema);
