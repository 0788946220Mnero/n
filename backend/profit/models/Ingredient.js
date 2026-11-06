const mongoose = require('mongoose');

/**
 * مادة خام أو تحضير وسيط (صلصة، تتبيلة، عجينة…).
 *   baseUnit: وحدة الحساب الداخلية — g | ml | pc. كل الكميات والتكاليف بها.
 *   purchaseUnits: وحدات الشراء ومعامل تحويلها (كرتونة = 24 pc، كيس = 5000 g).
 *   avgCost: متوسط التكلفة المرجّح لكل وحدة أساس (يتغيّر مع كل استلام).
 *   stockQty: الرصيد بوحدة الأساس — مخزَّن للسرعة فقط؛ الحقيقة في دفتر الحركات StockMovement.
 *   kind = prep: تحضير له وصفته (Recipe target=prep). trackMode:
 *     stock   ← يُنتج بدفعات (حركة إنتاج) ويُستهلك من رصيده
 *     explode ← لا رصيد له: البيع يستهلك مكوّناته الخام مباشرة
 */
const purchaseUnitSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 30 }, // كيس 5 كغ
    factor: { type: Number, required: true, min: 0.000001 },           // كم وحدة أساس فيها
  },
  { _id: false }
);

const ingredientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, enum: ['food', 'packaging', 'cleaning', 'other'], default: 'food', index: true },
    kind: { type: String, enum: ['raw', 'prep'], default: 'raw', index: true },
    trackMode: { type: String, enum: ['stock', 'explode'], default: 'stock' },
    baseUnit: { type: String, enum: ['g', 'ml', 'pc'], required: true },
    purchaseUnits: { type: [purchaseUnitSchema], default: [] },
    wastePct: { type: Number, default: 0, min: 0, max: 90 },      // هدر التحضير الافتراضي (تقشير، تقطيع)
    avgCost: { type: Number, default: 0, min: 0 },                 // دينار لكل وحدة أساس
    lastCost: { type: Number, default: 0, min: 0 },
    lastCostAt: { type: Date, default: null },
    stockQty: { type: Number, default: 0 },
    minStock: { type: Number, default: 0, min: 0 },                // حدّ التنبيه بوحدة الأساس
    supplier: { type: String, default: '', trim: true, maxlength: 80 },
    active: { type: Boolean, default: true, index: true },
    notes: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

ingredientSchema.index({ name: 1 }, { unique: true, collation: { locale: 'ar', strength: 2 }, name: 'ingredient_name' });

module.exports = mongoose.models.Ingredient || mongoose.model('Ingredient', ingredientSchema);
