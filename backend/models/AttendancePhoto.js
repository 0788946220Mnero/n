const mongoose = require('mongoose');

/** الصورة اللحظية عند الحضور/الانصراف — صغيرة (JPEG)، وتُحذف تلقائياً بعد مدة الإعدادات. */
const attendancePhotoSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', index: true },
    kind: { type: String, enum: ['in', 'out'], default: 'in' },
    mime: { type: String, default: 'image/jpeg' },
    data: { type: Buffer, required: true },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true }
);

attendancePhotoSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AttendancePhoto', attendancePhotoSchema);
