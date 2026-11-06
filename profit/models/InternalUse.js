const mongoose = require('mongoose');

/**
 * استهلاك داخلي بأصناف المنيو: وجبة موظف أو صنف تالف (سقط، رُفض، أُعيد).
 * يخصم مكوّنات الوصفة من المخزون ويُسجَّل تكلفةً تشغيلية — وليس إيراداً أبداً.
 * (هدر المادة الخام نفسها حركة waste مباشرة على المادة.)
 */
const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, default: '' },
    qty: { type: Number, required: true, min: 0.001 },
    addons: [{ name: String }],
  },
  { _id: false }
);

const internalUseSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['staff_meal', 'product_waste'], required: true, index: true },
    clientRef: { type: String, default: null },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    employeeName: { type: String, default: '' },
    items: { type: [itemSchema], default: [] },
    reason: { type: String, default: '', maxlength: 200 },
    at: { type: Date, required: true, default: Date.now, index: true },
    businessDay: { type: String, default: '' },
    cost: { type: Number, default: 0 },
    byName: { type: String, default: '' },
  },
  { timestamps: true }
);
internalUseSchema.index({ clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'internal_use_client_ref' });

module.exports = mongoose.models.InternalUse || mongoose.model('InternalUse', internalUseSchema);
