const mongoose = require('mongoose');
const { Schema } = mongoose;

/** متجر مسجَّل: يظهر على الخريطة بموقعه الدقيق، ويطلب سائقاً من تطبيقه. */
const storeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      at: { type: Date, default: Date.now },
    },
    active: { type: Boolean, default: true, index: true },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqStore', storeSchema, 'brq_stores');
