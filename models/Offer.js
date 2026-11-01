const mongoose = require('mongoose');

/*
  عرض ترويجي برابط خارجي — يُنشأ من «العروض الترويجية» في لوحة التحكم.
  • يوجّه إلى صنف (product) أو تصنيف كامل (category).
  • خصم ثابت بالدينار على سعر الصنف الأساسي (لا على الإضافات)، ويُحسب في الخادم عند الطلب.
  • صورة أو فيديو (media) تظهر في معاينة الرابط على فيسبوك وواتساب، وغلاف اختياري للفيديو.
  • الرابط: <الموقع>/o/<code> — صفحة بوسوم og يقرؤها فيسبوك، ثم تفتح العرض للزبون.
  الحقول القديمة (discountPercent / specialPrice / banner) باقية ولم تكن مستخدمة.
*/
const offerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    code: { type: String, unique: true, sparse: true, index: true }, // مقطع الرابط القصير /o/<code>
    targetType: { type: String, enum: ['product', 'category'], default: 'product' },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    discount: { type: Number, default: 0, min: 0 }, // خصم ثابت بالدينار لكل قطعة
    mediaUrl: { type: String, default: '' },
    mediaType: { type: String, enum: ['image', 'video', ''], default: '' },
    coverUrl: { type: String, default: '' }, // صورة المعاينة للفيديو (اختيارية)
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null }, // بلا نهاية = يبقى حتى يُوقف
    isActive: { type: Boolean, default: true },
    views: { type: Number, default: 0 }, // من فتح الرابط (بلا زواحف المعاينة)
    orders: { type: Number, default: 0 }, // طلبات وصلت بسعر العرض
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    // حقول قديمة غير مستخدمة — باقية كما هي
    discountPercent: { type: Number, default: 0 },
    specialPrice: { type: Number, default: null },
    banner: { type: String, default: '' },
  },
  { timestamps: true }
);

/** هل العرض فعّال الآن؟ */
offerSchema.statics.isLive = (o, now = new Date()) =>
  !!o && o.isActive !== false && (!o.startDate || new Date(o.startDate) <= now) && (!o.endDate || new Date(o.endDate) >= now);

module.exports = mongoose.model('Offer', offerSchema);
