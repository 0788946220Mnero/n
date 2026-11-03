const mongoose = require('mongoose');

/**
 * دوام موظف واحد: من «حضور» حتى «انصراف» على جهاز الحضور في المطعم.
 *  - الاستراحات (البريك) يسجّلها مسؤول القسم من حسابه، وتُخصم من ساعات العمل.
 *  - flags: ملاحظات تلقائية تظهر للمدير كاستثناءات حتى يعتمدها (reviewedAt).
 *  - edits: كل تعديل يدوي من المدير مع سببه (لا يُمسح).
 * اليوم المحسوب للدوام = تاريخ الحضور بتوقيت عمّان (workDay).
 */
const breakSchema = new mongoose.Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, default: null },
    minutes: { type: Number, default: 0 },
    note: { type: String, default: '', maxlength: 120 },
    manual: { type: Boolean, default: false },          // سُجّلت بعد حدوثها (بداية + مدة)
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    endedByName: { type: String, default: '' },
    alertedAt: { type: Date, default: null },            // أُرسل تنبيه «استراحة مفتوحة طويلة»
  },
  { _id: true }
);

const editSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    byName: { type: String, default: '' },
    reason: { type: String, default: '', maxlength: 200 },
    change: { type: String, default: '', maxlength: 200 },
  },
  { _id: false }
);

const attendanceShiftSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    section: { type: String, default: '' },
    workDay: { type: String, required: true, index: true },   // YYYY-MM-DD بتوقيت عمّان
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    // work دوام · half نصف دوام (يحسب نصف ساعات الموظف) · off عطلة (بلا ساعات) — النصف والعطلة يسجّلهما المدير
    dayType: { type: String, enum: ['work', 'half', 'off'], default: 'work' },
    settlement: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeSettlement', default: null, index: true },
    alertLongAt: { type: Date, default: null },          // أُرسل تنبيه «دوام مفتوح أكثر من الحد»
    clockInAt: { type: Date, required: true, index: true },
    clockOutAt: { type: Date, default: null },
    inDevice: { type: String, default: '' },
    outDevice: { type: String, default: '' },
    inIp: { type: String, default: '' },
    outIp: { type: String, default: '' },
    inPhoto: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendancePhoto', default: null },
    outPhoto: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendancePhoto', default: null },
    closedByName: { type: String, default: '' },            // إن أغلقه المدير بدل الموظف
    breaks: { type: [breakSchema], default: [] },
    breakMinutes: { type: Number, default: 0 },
    workedMinutes: { type: Number, default: 0 },             // يُحسب عند الانصراف (الإجمالي − البريك)
    lateMinutes: { type: Number, default: 0 },
    flags: { type: [String], default: [] },
    reviewedAt: { type: Date, default: null },
    reviewedByName: { type: String, default: '' },
    reviewNote: { type: String, default: '' },
    edits: { type: [editSchema], default: [] },
  },
  { timestamps: true }
);

// دوام مفتوح واحد فقط لكل موظف — يمنع «حضور» مرتين حتى لو ضُغط من جهازين في نفس اللحظة
attendanceShiftSchema.index({ employee: 1 }, { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_shift' });
attendanceShiftSchema.index({ employee: 1, workDay: -1 });

module.exports = mongoose.model('AttendanceShift', attendanceShiftSchema);
