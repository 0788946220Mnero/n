const mongoose = require('mongoose');
const { Schema } = mongoose;

/** منطقة توصيل: يختار المتجر اسمها، ومركزها يُستخدم لحساب المسافة والتسعير. */
const areaSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60, unique: true },
    center: { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqArea', areaSchema, 'brq_areas');
