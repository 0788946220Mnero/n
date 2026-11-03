const mongoose = require('mongoose');
const { Schema } = mongoose;

const driverSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, unique: true, index: true },
    pinHash: { type: String, required: true },

    // رمز OTP طويل الصلاحية — يُرسله المدير للسائق يدوياً، ويُخزَّن مُجزَّأً فقط
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },

    active: { type: Boolean, default: true, index: true },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },

    vehicle: { type: String, default: '', maxlength: 60 },
    // بيانات التصريح المطبوع للسائق
    plate: { type: String, default: '', maxlength: 30 },       // رقم لوحة المركبة
    nationalId: { type: String, default: '', maxlength: 30 },  // الرقم الوطني / الهوية
    permitNo: { type: String, default: '' },                   // رقم التصريح (يُولَّد عند أول طباعة)
    permitIssuedAt: { type: Date, default: null },
    permitExpiresAt: { type: Date, default: null },
    status: { type: String, enum: ['offline', 'available', 'busy'], default: 'offline' },
    // التوصيلة الحالية (إن وُجدت) — تبقى حركته معروضة على الخريطة
    // الرحلات المفتوحة للسائق (عدد أقصاه من الإعدادات maxConcurrentTrips)
    currentTrips: { type: [{ type: Schema.Types.ObjectId, ref: 'BrqTrip' }], default: [] },

    // رموز FCM للإشعارات حين لا يكون التطبيق مفتوحاً
    pushTokens: { type: [String], default: [] },

    // التقييم الإجمالي من المتاجر
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },

    lastLocation: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      heading: Number,
      speed: Number,
      at: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqDriver', driverSchema, 'brq_drivers');
