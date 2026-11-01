const mongoose = require('mongoose');

/*
  صور الزبائن: الصورة الشخصية (avatar — عامة داخل الدردشة العامة) وصور محادثة فريق العمل
  (support — خاصة: لصاحب المحادثة والطاقم فقط). محفوظة في القاعدة نفسها، مضغوطة قبل الرفع،
  وبلا بيانات وصفية (EXIF/الموقع) — utils/imageSafe.js.
*/
const mediaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['avatar', 'support'], required: true, index: true },
    mime: { type: String, required: true },
    size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    data: { type: Buffer, select: false },
    phoneUser: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneUser', default: null, index: true },
    staffUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    thread: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportThread', default: null, index: true },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CustomerMedia', mediaSchema);
