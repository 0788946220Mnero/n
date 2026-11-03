const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * حركة تحصيل/تسوية في جرد البراق:
 *   • driver: السائق يدفع للشركة حصتها (companyFils) من التوصيلات — يُطبع له سند قبض.
 *   • store : المتجر يدفع للشركة (إن كانت الشركة تحصّل من المتاجر) — اختياري.
 * amountFils موجب = دفع للشركة، سالب = تسوية لصالح الطرف.
 */
const schema = new Schema(
  {
    party: { type: String, enum: ['driver', 'store'], required: true, index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'BrqDriver', default: null, index: true },
    store: { type: Schema.Types.ObjectId, ref: 'BrqStore', default: null, index: true },
    partyName: { type: String, default: '' },
    amountFils: { type: Number, required: true },
    note: { type: String, default: '', maxlength: 200 },
    receiptNo: { type: String, required: true, unique: true },
    by: { type: Schema.Types.ObjectId, default: null },
    byName: { type: String, default: '' },
    voided: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqSettlement', schema, 'brq_settlements');
