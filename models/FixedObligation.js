const mongoose = require('mongoose');

/**
 * التزام ثابت: مبلغ متكرر على المطعم (إيجار، اشتراك، قسط…) بموعد سداد.
 * يُقسَّم يومياً على الأيام المتبقية حتى الموعد، ويُدفع كل يوم بسند صرف تسلسلي
 * عليه ختم «مدفوع» وتوقيع مدير النظام الذي اعتمد الالتزام.
 * الدورات (كل شهر/مرة واحدة) في ObligationCycle.
 *
 * لا يُحذف أبداً: الإيقاف يمنع الدورات القادمة، والأرشفة لمدير النظام وحده.
 */
const fixedObligationSchema = new mongoose.Schema(
  {
    number: { type: Number, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 }, // «إيجار المحل»
    payee: { type: String, required: true, trim: true, maxlength: 80 }, // لمن يُدفع (يصبح اسم المورّد عند التصدير للذمم)
    phone: { type: String, default: '', trim: true, maxlength: 20 },
    notes: { type: String, default: '', trim: true, maxlength: 300 },
    amount: { type: Number, required: true, min: 0.001, max: 1000000 }, // مبلغ الدورة
    recurrence: { type: String, enum: ['monthly', 'once'], default: 'monthly' },
    dueDay: { type: Number, min: 1, max: 31, default: 1 }, // يوم الاستحقاق في الشهر (للمتكرر)

    active: { type: Boolean, default: true, index: true }, // موقوف ← لا دورات جديدة
    archived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedByName: { type: String, default: '' },

    // اعتماد مدير النظام: الاسم والتوقيع منسوخان لحظة الاعتماد، ويُطبعان على كل سند يومي
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedByName: { type: String, default: '' },
    approvedAt: { type: Date, default: null },
    approvedSignature: { type: String, default: '', select: false },

    brand: { type: String, default: 'diyar' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FixedObligation', fixedObligationSchema);
