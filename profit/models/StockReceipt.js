const mongoose = require('mongoose');

/**
 * استلام بضاعة (فاتورة مورّد): يُدخل الكميات للمخزون ويحدّث متوسط التكلفة المرجّح.
 * شراء البضاعة ليس مصروفاً تشغيلياً — المصروف هو الاستهلاك (تكلفة المبيعات).
 * الدفع للمورّد يبقى في «ذمم الموردين»/المصروفات (حركة نقد)، ويُستبعد من التشغيلي بفئته.
 */
const lineSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    ingredientName: { type: String, default: '' },
    qty: { type: Number, required: true, min: 0.000001 },   // بوحدة الشراء
    unit: { type: String, required: true },                 // اسم الوحدة (كيس 5 كغ، kg، pc…)
    factor: { type: Number, required: true, min: 0.000001 },// وحدات أساس في وحدة الشراء
    unitPrice: { type: Number, required: true, min: 0 },     // سعر وحدة الشراء
    total: { type: Number, required: true, min: 0 },
    baseQty: { type: Number, required: true },
    baseCost: { type: Number, required: true },              // تكلفة وحدة الأساس
  },
  { _id: false }
);

const stockReceiptSchema = new mongoose.Schema(
  {
    number: { type: Number, index: true },
    clientRef: { type: String, default: null },
    supplier: { type: String, default: '', trim: true, maxlength: 80 },
    invoiceNumber: { type: String, default: '', trim: true, maxlength: 40 },
    receivable: { type: mongoose.Schema.Types.ObjectId, ref: 'Receivable', default: null },
    lines: { type: [lineSchema], default: [] },
    total: { type: Number, default: 0 },
    receivedAt: { type: Date, required: true, default: Date.now },
    businessDay: { type: String, default: '' },
    notes: { type: String, default: '', maxlength: 300 },
    byName: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
stockReceiptSchema.index({ clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'receipt_client_ref' });

module.exports = mongoose.models.StockReceipt || mongoose.model('StockReceipt', stockReceiptSchema);
