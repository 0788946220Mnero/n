const mongoose = require('mongoose');

/**
 * دورة التزام ثابت: من يوم البداية حتى موعد السداد (شاملاً)، بمبلغ محدد.
 *  open    ← تُقسَّم يومياً وتُدفع أقساطها
 *  closed  ← انتهى موعدها: سُدّدت كاملة (settled)، أو صُدِّر المتبقي لذمم الموردين (exported)
 *
 * paid يُحدَّث ذرّياً مع كل دفعة (مقارنة وتبديل) فلا يتجاوز مجموع الأقساط مبلغ الدورة
 * حتى لو دفع كاشيران في اللحظة نفسها؛ وإلغاء سند يُنقصه.
 * الأيام بصيغة YYYY-MM-DD بتوقيت عمّان.
 */
const obligationCycleSchema = new mongoose.Schema(
  {
    obligation: { type: mongoose.Schema.Types.ObjectId, ref: 'FixedObligation', required: true, index: true },
    seq: { type: Number, default: 1 },
    startDay: { type: String, required: true }, // أول يوم يُدفع فيه
    dueDay: { type: String, required: true }, // موعد السداد — آخر يوم
    amount: { type: Number, required: true, min: 0.001 },
    paid: { type: Number, default: 0 },
    payments: { type: Number, default: 0 },

    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    outcome: { type: String, enum: ['', 'settled', 'exported', 'cancelled'], default: '' }, // cancelled: أُرشف الالتزام قبل أي دفعة
    closedAt: { type: Date, default: null },
    exportedAmount: { type: Number, default: 0 },
    receivable: { type: mongoose.Schema.Types.ObjectId, ref: 'Receivable', default: null },
    receivableNumber: { type: Number, default: null },

    // الأيام التي نُبِّه فيها بأن القسط لم يُدفع (لا يتكرر التنبيه لليوم نفسه)
    missedNotified: { type: [String], default: [] },
  },
  { timestamps: true }
);

obligationCycleSchema.index({ obligation: 1, seq: 1 }, { unique: true });

module.exports = mongoose.model('ObligationCycle', obligationCycleSchema);
