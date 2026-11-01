const mongoose = require('mongoose');

/**
 * تصفية موظف: تُغلق فترة كاملة — الدوامات والاستراحات والعطل والراتب وما صُرف له —
 * فتعود أرقامه الجارية إلى الصفر، وتبقى هذه الصورة في الأرشيف تُفتح وتُطبع متى شئت.
 * الدوامات والسندات الداخلة تحمل رقم التصفية (settlement) فلا تُعدّل ولا تُلغى بعدها.
 */
const settlementSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    jobTitle: { type: String, default: '' },
    section: { type: String, default: '' },
    from: { type: Date, default: null },
    to: { type: Date, required: true },
    salary: { type: Number, default: 0 },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },      // الأيام، النصف، العطل، الساعات، الاستراحات، التأخير
    shifts: { type: [mongoose.Schema.Types.Mixed], default: [] },     // صورة مختصرة لكل دوام
    payments: { type: [mongoose.Schema.Types.Mixed], default: [] },   // سندات الصرف الداخلة
    paid: { type: mongoose.Schema.Types.Mixed, default: {} },         // { salary, advance, bonus, other, all, count }
    remaining: { type: Number, default: 0 },                           // الراتب − (رواتب + سلف)
    note: { type: String, default: '', maxlength: 300 },
    byName: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
settlementSchema.index({ employee: 1, createdAt: -1 });

module.exports = mongoose.model('EmployeeSettlement', settlementSchema);
