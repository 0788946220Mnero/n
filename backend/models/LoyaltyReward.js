const mongoose = require('mongoose');

/**
 * مكافأة يستبدلها الزبون بنقاطه عند الكاشير.
 *   amount     خصم بقيمة ثابتة (value د.أ) — لا يتجاوز قيمة الأصناف
 *   free_item  صنف مجاني (product) — يجب أن يكون في السلة؛ يُخصم سعره الأساسي لقطعة واحدة
 */
const loyaltyRewardSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 300 },
    type: { type: String, enum: ['amount', 'free_item'], default: 'amount' },
    pointsCost: { type: Number, required: true, min: 1 },
    value: { type: Number, default: 0, min: 0 },                       // للخصم الثابت
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    productName: { type: String, default: '' },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

loyaltyRewardSchema.index({ active: 1, sortOrder: 1, pointsCost: 1 });

module.exports = mongoose.model('LoyaltyReward', loyaltyRewardSchema);
