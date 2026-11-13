const mongoose = require('mongoose');

/**
 * بند تكلفة تشغيلية يُوزَّع على أيام العمل (ليس حركة نقد):
 *   monthly      ← مبلغ شهري ثابت ÷ أيام الشهر (إيجار، إنترنت، اشتراك)      [موزّع]
 *   bills        ← فواتير فعلية بفتراتها (كهرباء، ماء، غاز): يوم داخل فاتورة ← حصته منها [فعلي موزّع]،
 *                  يوم بلا فاتورة بعد ← متوسط يومي لآخر 3 فواتير                 [تقديري]
 *   depreciation ← (التكلفة − الخردة) ÷ العمر بالأشهر ÷ أيام الشهر، ضمن العمر فقط [موزّع]
 *   per_order    ← مبلغ × عدد الطلبات (تغليف غير مضمّن في الوصفات مثلاً)        [تقديري]
 *   percent      ← نسبة من مبيعات (base: net | card | delivery) — رسوم الدفع الإلكتروني [تقديري]
 * obligation: مرتبط بالتزام ثابت؛ دفعاته اليومية حركة نقد لا تُحسب مرة ثانية في التشغيلي.
 */
const billSchema = new mongoose.Schema(
  {
    from: { type: String, required: true }, // YYYY-MM-DD
    to: { type: String, required: true },   // YYYY-MM-DD (شامل)
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: '', maxlength: 120 },
    addedByName: { type: String, default: '' },
  },
  { _id: true }
);

const costItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, enum: ['rent', 'utilities', 'internet', 'maintenance', 'cleaning', 'depreciation', 'subscription', 'packaging', 'fees', 'delivery', 'other'], default: 'other', index: true },
    method: { type: String, enum: ['monthly', 'bills', 'depreciation', 'per_order', 'percent'], required: true },
    amount: { type: Number, default: 0, min: 0 },     // monthly: شهري | per_order: لكل طلب
    percent: { type: Number, default: 0, min: 0, max: 100 },
    percentBase: { type: String, enum: ['net', 'card', 'delivery'], default: 'net' },
    assetCost: { type: Number, default: 0, min: 0 },
    salvage: { type: Number, default: 0, min: 0 },
    lifeMonths: { type: Number, default: 0, min: 0 },
    bills: { type: [billSchema], default: [] },
    startDate: { type: String, required: true },     // YYYY-MM-DD
    endDate: { type: String, default: '' },
    obligation: { type: mongoose.Schema.Types.ObjectId, ref: 'FixedObligation', default: null },
    active: { type: Boolean, default: true, index: true },
    notes: { type: String, default: '', maxlength: 300 },
    byName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.CostItem || mongoose.model('CostItem', costItemSchema);
