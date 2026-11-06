const mongoose = require('mongoose');

/**
 * لقطة تكلفة ثابتة لكل سطر مبيع (أو وجبة موظف / تالف صنف): تُكتب مرة واحدة لحظة الترحيل
 * بنسخة الوصفة السارية وقت البيع ومتوسط تكلفة المواد في تلك اللحظة — ولا تُعاد حسابها أبداً.
 * التقارير التاريخية تقرأ من هنا، فلا تتأثر بأسعار اليوم.
 */
const componentSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient' },
    name: String,
    role: { type: String, default: 'material' },
    qty: Number,       // بوحدة الأساس شاملة الهدر، لكل الكمية المباعة
    unitCost: Number,
    cost: Number,
    addon: { type: String, default: '' },
  },
  { _id: false }
);

const saleCostSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },               // sale:<orderId>:<line> | meal:<id>:<line> | pwaste:<id>:<line>
    kind: { type: String, enum: ['sale', 'staff_meal', 'product_waste'], default: 'sale', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    orderNumber: { type: String, default: '' },
    lineIndex: { type: Number, default: 0 },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    productName: { type: String, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    channel: { type: String, default: '' },              // pos | web-delivery | web-pickup | hall | center | app
    qty: { type: Number, default: 1 },
    revenue: { type: Number, default: 0 },               // صافي السطر بعد العرض (قبل خصم الفاتورة)
    discountShare: { type: Number, default: 0 },         // حصة السطر من خصم الفاتورة (بنسبة قيمته)
    recipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', default: null },
    recipeVersion: { type: Number, default: null },
    material: { type: Number, default: 0 },
    packaging: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },                  // material + packaging لكل الكمية
    missingRecipe: { type: Boolean, default: false, index: true },
    missingCost: { type: Boolean, default: false },      // مادة بلا تكلفة (لم يُسجّل لها استلام)
    components: { type: [componentSchema], default: [] },
    at: { type: Date, required: true, index: true },     // وقت البيع الفعلي
    businessDay: { type: String, default: '', index: true },
    shiftId: { type: String, default: '' },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    employeeName: { type: String, default: '' },
    reversed: { type: Boolean, default: false, index: true },
    reversedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

saleCostSchema.index({ key: 1 }, { unique: true, name: 'sale_cost_key' });
saleCostSchema.index({ kind: 1, at: 1 });

module.exports = mongoose.models.SaleCost || mongoose.model('SaleCost', saleCostSchema);
