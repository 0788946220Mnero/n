const mongoose = require('mongoose');

/**
 * دفتر حركات المخزون — لا يُعدَّل ولا يُحذف. التصحيح بحركة عكسية.
 *   qty: موقّعة بوحدة الأساس (+ دخول، − خروج)
 *   unitCost: تكلفة الوحدة المعتمدة للحركة، value = qty × unitCost (موقّعة)
 *   key: مفتاح فريد يمنع تكرار الحركة نفسها (خصم البيع مرتين، استلام مرتين…)
 */
const TYPES = ['opening', 'receive', 'sale', 'sale_reversal', 'staff_meal', 'waste', 'expired',
  'product_waste', 'adjust', 'count', 'transfer_out', 'transfer_in', 'prep_in', 'prep_out'];

const stockMovementSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true, index: true },
    ingredientName: { type: String, default: '' },
    type: { type: String, enum: TYPES, required: true, index: true },
    qty: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    at: { type: Date, required: true, default: Date.now, index: true },
    businessDay: { type: String, default: '', index: true }, // YYYY-MM-DD (يوم العمل لا يوم التقويم)
    refType: { type: String, default: '' },   // order | receipt | count | meal | waste | batch | manual
    refId: { type: String, default: '', index: true },
    reason: { type: String, default: '', maxlength: 200 },
    byName: { type: String, default: '' },
  },
  { timestamps: true }
);

stockMovementSchema.index({ key: 1 }, { unique: true, name: 'stock_movement_key' });
stockMovementSchema.index({ ingredient: 1, at: 1 });

module.exports = mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
module.exports.TYPES = TYPES;
