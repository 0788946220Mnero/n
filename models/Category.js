const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true },
    image: { type: String, default: '' },
    isVisible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },

    // ✅ طابعة القسم — أصناف هذا التصنيف تُطبع عليها.
    // null يعني: استخدم الطابعة الرئيسية.
    printer: { type: mongoose.Schema.Types.ObjectId, ref: 'Printer', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Category', categorySchema);
