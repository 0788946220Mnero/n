const mongoose = require('mongoose');

const addonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    nameAr: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true },
    oldPrice: { type: Number, default: null },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    image: { type: String, default: '' },
    images: [{ type: String }],
    addons: [addonSchema],
    isAvailable: { type: Boolean, default: true },
    // المخزون (الجرد) — اتركه فارغاً (null) لمنتج غير محدود الكمية، أو رقم لتتبّع الكمية المتوفرة.
    // يُخصم تلقائياً عند تأكيد الطلب من لوحة التحكم فقط، وليس عند إنشاء الطلب.
    stock: { type: Number, default: null },
    views: { type: Number, default: 0 },
    ordersCount: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

productSchema.index({ nameAr: 'text', nameEn: 'text' });

module.exports = mongoose.model('Product', productSchema);
