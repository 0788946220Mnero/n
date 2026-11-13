const mongoose = require('mongoose');

/**
 * وصفة بنسخ: كل تعديل يُنشئ نسخة جديدة ولا يُعدّل القديمة أبداً،
 * فالمبيعات السابقة تبقى مربوطة بالنسخة التي كانت سارية وقت بيعها.
 *
 *   target: product (صنف في المنيو) | prep (تحضير وسيط = Ingredient kind prep)
 *   lines: المكوّنات لقطعة واحدة من الصنف (أو لدفعة yieldQty من التحضير)
 *   role: material (مادة) | packaging (تغليف: علبة، كيس، محارم)
 *   addonLines: مكوّنات الإضافات بالاسم كما في Product.addons —
 *               كمية سالبة = إزالة/استبدال («بدون مايونيز»)
 */
const lineSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    qty: { type: Number, required: true },
    unit: { type: String, required: true, trim: true, maxlength: 30 }, // g kg ml l pc أو اسم وحدة شراء
    wastePct: { type: Number, default: null, min: 0, max: 90 },        // null = هدر المادة الافتراضي
    role: { type: String, enum: ['material', 'packaging'], default: 'material' },
  },
  { _id: false }
);

const addonLinesSchema = new mongoose.Schema(
  {
    addonName: { type: String, required: true, trim: true, maxlength: 60 },
    lines: { type: [lineSchema], default: [] },
  },
  { _id: false }
);

const recipeSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: ['product', 'prep'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    targetName: { type: String, default: '' },
    version: { type: Number, required: true, min: 1 },
    current: { type: Boolean, default: true, index: true },
    effectiveFrom: { type: Date, required: true, default: Date.now },
    effectiveTo: { type: Date, default: null },
    yieldQty: { type: Number, default: 1, min: 0.000001 }, // للتحضير: كمية الناتج بوحدة أساسه
    lines: { type: [lineSchema], default: [] },
    addonLines: { type: [addonLinesSchema], default: [] },
    notes: { type: String, default: '', maxlength: 300 },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

recipeSchema.index({ targetType: 1, target: 1, version: 1 }, { unique: true, name: 'recipe_version' });
recipeSchema.index({ targetType: 1, target: 1, current: 1 });

module.exports = mongoose.models.Recipe || mongoose.model('Recipe', recipeSchema);
