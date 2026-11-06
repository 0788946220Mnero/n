const mongoose = require('mongoose');

/**
 * جرد فعلي للمواد: المتوقع (من الدفتر) مقابل المعدود. عند الاعتماد تُكتب حركة count
 * بالفرق لكل مادة (عجز/زيادة) بقيمتها — مرة واحدة فقط (status posted + مفتاح الحركة).
 */
const lineSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    ingredientName: { type: String, default: '' },
    baseUnit: { type: String, default: '' },
    expected: { type: Number, default: 0 },
    counted: { type: Number, required: true },
    diff: { type: Number, default: 0 },     // counted − expected
    unitCost: { type: Number, default: 0 },
    value: { type: Number, default: 0 },    // diff × unitCost (سالب = عجز)
  },
  { _id: false }
);

const stockCountSchema = new mongoose.Schema(
  {
    number: { type: Number, index: true },
    status: { type: String, enum: ['draft', 'posted'], default: 'draft', index: true },
    countedAt: { type: Date, required: true, default: Date.now },
    businessDay: { type: String, default: '' },
    lines: { type: [lineSchema], default: [] },
    shortageValue: { type: Number, default: 0 },
    surplusValue: { type: Number, default: 0 },
    notes: { type: String, default: '', maxlength: 300 },
    byName: { type: String, default: '' },
    postedAt: { type: Date, default: null },
    postedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.StockCount || mongoose.model('StockCount', stockCountSchema);
