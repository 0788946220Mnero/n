const mongoose = require('mongoose');

/** موظف في المطعم (سجل موارد بشرية — ليس حساب دخول للوحة). صرفه: مصروفات مرتبطة به. */
const employeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: '', trim: true, maxlength: 20 },
    jobTitle: { type: String, default: '', trim: true, maxlength: 60 },   // طبّاخ، كاشير، عامل نظافة…
    salary: { type: Number, default: 0, min: 0 },
    hourlyRate: { type: Number, default: null, min: 0 },                // أجر الساعة (اختياري) — وإلا يُشتق من الراتب الشهري لحساب تكلفة العمالة                        // الراتب الشهري (اختياري)
    startDate: { type: Date, default: null },
    notes: { type: String, default: '', maxlength: 300 },
    active: { type: Boolean, default: true, index: true },
    createdByName: { type: String, default: '' },

    // ═══ الدوام ═══
    section: { type: String, default: '', trim: true, maxlength: 40 },  // المطبخ، الكاشير، الصالة…
    shiftStart: { type: String, default: '' },                          // HH:mm — موعد الحضور (للتأخير)
    shiftHours: { type: Number, default: 0, min: 0, max: 24 },           // ساعات الدوام المتوقعة (للإضافي)
    pinHash: { type: String, default: '', select: false },
    pinPrevHash: { type: String, default: '', select: false },
    pinSetAt: { type: Date, default: null },
    pinMustChange: { type: Boolean, default: false },
    pinFails: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },
    lastPunchAt: { type: Date, default: null },
    lastSettledAt: { type: Date, default: null },
    settlingAt: { type: Date, default: null },  // قفل قصير أثناء التصفية (لا تصفيتان معاً)
  },
  { timestamps: true }
);

module.exports = mongoose.model('Employee', employeeSchema);
