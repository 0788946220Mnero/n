const mongoose = require('mongoose');

/**
 * جهاز حضور موثوق (تابلت في المطعم). يُربط مرة واحدة برمز مؤقت يصدره المدير،
 * ثم يحمل مفتاحاً سرياً (نحفظ بصمته sha256 فقط). الإلغاء يقطع الجهاز فوراً.
 */
const attendanceDeviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    tokenHash: { type: String, default: '', index: true },
    pairCodeHash: { type: String, default: '' },
    pairExpiresAt: { type: Date, default: null },
    pairedAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    lastIp: { type: String, default: '' },
    lastSeenAt: { type: Date, default: null },
    createdByName: { type: String, default: '' },
    revokedAt: { type: Date, default: null },
    revokedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AttendanceDevice', attendanceDeviceSchema);
