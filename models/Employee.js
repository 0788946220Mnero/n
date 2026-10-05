const mongoose = require('mongoose');

/** موظف في المطعم (سجل موارد بشرية — ليس حساب دخول للوحة). صرفه: مصروفات مرتبطة به. */
const employeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: '', trim: true, maxlength: 20 },
    jobTitle: { type: String, default: '', trim: true, maxlength: 60 },   // طبّاخ، كاشير، عامل نظافة…
    salary: { type: Number, default: 0, min: 0 },                        // الراتب الشهري (اختياري)
    startDate: { type: Date, default: null },
    notes: { type: String, default: '', maxlength: 300 },
    active: { type: Boolean, default: true, index: true },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Employee', employeeSchema);
