const mongoose = require('mongoose');

/**
 * دورة جرد (Inventory / Shift Session).
 * كل دورة تبقى محفوظة: فتح دورة جديدة لا يمسح القديمة.
 * الطلبات نفسها تحمل shiftId عند الإغلاق كما كان سابقاً — هذا السجل يضيف
 * من فتح ومتى، ومن أغلق ومتى، وملخص الأرقام لحظة الإغلاق.
 */
const shiftSessionSchema = new mongoose.Schema(
  {
    // نفس المعرّف المكتوب على الطلبات عند الإغلاق (SHIFT-...)، ويُولَّد عند الفتح
    shiftId: { type: String, required: true, unique: true },
    // mine = جرد مستخدم | all = جرد المطعم كاملاً
    scope: { type: String, enum: ['mine', 'all'], default: 'mine', index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    userName: { type: String, default: '' },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },

    openedAt: { type: Date, default: Date.now },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    openedByName: { type: String, default: '' },
    // فُتحت تلقائياً عند أول عملية بيع/تأكيد (بلا ضغط «فتح الجرد»)
    autoOpened: { type: Boolean, default: false },

    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedByName: { type: String, default: '' },
    // أُغلقت ضمن «جرد المطعم كاملاً»
    closedViaShiftId: { type: String, default: '' },

    // بداية ونهاية فترة الطلبات الفعلية
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    // أرقام مختصرة للبحث والجداول، والملخص الكامل كما طُبع
    ordersCount: { type: Number, default: 0 },
    salesTotal: { type: Number, default: 0 },
    deliveryTotal: { type: Number, default: 0 },
    cashTotal: { type: Number, default: 0 },
    otherPaymentsTotal: { type: Number, default: 0 },
    expensesTotal: { type: Number, default: 0 },
    cashNet: { type: Number, default: 0 },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

shiftSessionSchema.index({ user: 1, status: 1, scope: 1 });
// دورة مفتوحة واحدة لكل مستخدم (فهرس جزئي: لا يمس الدورات المغلقة)
shiftSessionSchema.index(
  { user: 1, scope: 1 },
  { unique: true, partialFilterExpression: { status: 'open', scope: 'mine' }, name: 'one_open_shift_per_user' }
);
shiftSessionSchema.index({ openedAt: -1 });

module.exports = mongoose.model('ShiftSession', shiftSessionSchema);
