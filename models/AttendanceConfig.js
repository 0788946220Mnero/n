const mongoose = require('mongoose');

/**
 * إعدادات الدوام (وثيقة واحدة) — منفصلة عن إعدادات المطعم لأن تلك مكشوفة للعموم.
 *  allowedIps: عناوين شبكة المطعم المسموح التسجيل منها (فارغة = بلا قيد)، تقبل IPv4 أو CIDR.
 *  supervisors: نطاق مسؤول القسم — إن وُجد له سطر يرى موظفي أقسامه فقط، وإلا يرى الجميع.
 */
const attendanceConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    allowedIps: { type: [String], default: [] },
    requirePhoto: { type: Boolean, default: true },
    lateGraceMin: { type: Number, default: 10, min: 0, max: 180 },
    longBreakMin: { type: Number, default: 30, min: 1, max: 600 },
    maxShiftHours: { type: Number, default: 14, min: 1, max: 48 },
    pinMaxDays: { type: Number, default: 90, min: 0, max: 3650 },   // 0 = بلا تغيير دوري
    photoDays: { type: Number, default: 60, min: 1, max: 365 },
    supervisors: {
      type: [{ _id: false, user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, userName: String, sections: [String] }],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AttendanceConfig', attendanceConfigSchema);
