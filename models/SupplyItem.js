const mongoose = require('mongoose');

/** بند في «قائمة البضائع المطلوبة للمطعم» (بديل ورقة المشتريات). */
const supplyItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: String, default: '', trim: true, maxlength: 40 }, // «2 كرتونة»، «5 كغ»
    note: { type: String, default: '', trim: true, maxlength: 200 },
    urgent: { type: Boolean, default: false },
    status: { type: String, enum: ['needed', 'bought'], default: 'needed', index: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedByName: { type: String, default: '' },
    boughtAt: { type: Date, default: null },
    boughtByName: { type: String, default: '' },
  },
  { timestamps: true }
);

supplyItemSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SupplyItem', supplyItemSchema);
