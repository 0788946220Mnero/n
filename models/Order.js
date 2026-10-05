const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    nameAr: String,
    quantity: { type: Number, default: 1 },
    price: Number,
    addons: [{ name: String, price: Number }],
    // طابعة القسم وقت إنشاء الطلب (تُنسخ من المنتج لتبقى ثابتة لاحقاً)
    printerName: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    // العلامة/المطعم الذي جاء منه الطلب (للعزل بين ديار الأنباط ورواء)
    // القيمة الافتراضية 'diyar' تحافظ على كل الطلبات القديمة كما هي دون أي تغيير
    brand: { type: String, default: 'diyar', index: true },
    // مصدر الطلب: الموقع، أو تطبيق نقطة البيع (بيع مباشر على الكاشير)
    source: { type: String, enum: ['web', 'pos', 'app'], default: 'web', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: String,
    phone: String,
    address: String,
    items: [orderItemSchema],
    itemsTotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    // cash نقدي | cliq كليك | card فيزا/بطاقة | online (قديم، يبقى للتوافق)
    paymentMethod: { type: String, enum: ['cash', 'cliq', 'card', 'online'], default: 'cash' },
    orderType: { type: String, enum: ['delivery', 'pickup'], default: 'delivery' },

    // ═══ بيانات التوصيل (اختيارية — الطلبات القديمة تبقى صالحة) ═══
    customerLatitude: { type: Number, default: null },
    customerLongitude: { type: Number, default: null },
    deliveryDistance: { type: Number, default: null },   // بالكيلومترات
    deliveryDistanceMode: { type: String, default: '' }, // straight | road
    notes: { type: String, default: '' },
    status: {
      type: String,
      // pending: طلب جديد وصل من الموقع، لم يُؤكَّد بعد من الموظف — لا يدخل الإحصائيات ولا يخصم من الجرد
      // new وما بعدها: حالات الطلب المؤكَّد بعد ضغط "تأكيد الطلب" من لوحة التحكم
      enum: ['pending', 'new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'],
      default: 'pending',
    },
    confirmedAt: { type: Date, default: null },
    // أول من تعامل مع الطلب: بائع السفري، أو من أكّد طلب المنصة أو ألغاه.
    // أساس «الجرد لكل مستخدم» — كلٌّ يُغلق طلباته هو.
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    handledByName: { type: String, default: '' },
    // أثر الإلغاء للمراجعة: من ألغى ولماذا
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '', maxlength: 200 },
    cancelledAt: { type: Date, default: null },
    // مصدر البيع المباشر: 'app' شاشة C# (تطبع فاتورتها بنفسها) | 'web' نقطة البيع في اللوحة
    posChannel: { type: String, default: '' },
    // معرّف يولّده المتصفح لكل عملية بيع: إعادة الإرسال بنفسه لا تُنشئ طلباً ثانياً
    clientRef: { type: String, default: '', index: true },
    // بيع تمّ وطُبع على جهاز الكاشير بلا إنترنت ثم زُومن: رقمه المؤقت المطبوع للزبون ووقته الفعلي
    offlineNumber: { type: String, default: '' },
    offlineSoldAt: { type: Date, default: null },
    // إغلاق الجرد: تُؤرشف الطلبات بدل حذفها (السجل المالي يبقى محفوظاً دائماً)
    closed: { type: Boolean, default: false, index: true },
    closedAt: { type: Date, default: null },
    shiftId: { type: String, default: '' },
    // دفتر التوصيل: رسوم التوصيل أمانة للمندوبين المستقلين، لا تدخل جرد أي مستخدم.
    // تُسوّى مرة واحدة في «جرد المطعم كاملاً» للأدمن فقط — مستقلة عن أرشفة الطلب نفسه.
    deliverySettled: { type: Boolean, default: false, index: true },
    // المندوب الذي خرج بالطلب (مستخدم بدور delivery)
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    driverName: { type: String, default: '' },
    driverAssignedAt: { type: Date, default: null },
    deliverySettledAt: { type: Date, default: null },
    deliveryShiftId: { type: String, default: '' },
    // ═══ التتبع وسجل التوصيل (حقول اختيارية — الطلبات القديمة تبقى صالحة) ═══
    // رمز سري يُعطى للزبون عند الطلب: به يتابع طلبه ويرى سجله، ولا يُعرض في قوائم الإدارة
    trackingToken: { type: String, default: '', select: false },
    // لحظات التوصيل الحقيقية كما سجّلها الخادم
    deliverySentAt: { type: Date, default: null },       // أُرسلت تفاصيل الطلب للمندوب
    deliverySentByName: { type: String, default: '' },
    outForDeliveryAt: { type: Date, default: null },     // خرج للتوصيل
    deliveredAt: { type: Date, default: null },          // تم التسليم
    // أُزيل من خريطة التوصيل الحية (طلب عالق من جرد سابق) — لا يغيّر حالته ولا يحذفه
    mapHidden: { type: Boolean, default: false },
    mapHiddenAt: { type: Date, default: null },
    mapHiddenByName: { type: String, default: '' },
    // تسلسل الحالات (للتتبع ولسجل التوصيل)
    timeline: [
      {
        _id: false,
        event: String,      // status:<حالة> | driver_assigned | delivery_sent
        at: Date,
        byName: String,
      },
    ],
    printRequested: { type: Boolean, default: false },
    printed: { type: Boolean, default: false },
    printedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* رمز التتبع سرّ الزبون: لا يخرج في أي رد JSON (قوائم الإدارة، تحديث الحالة...).
   عمليات «ابحث وحدّث» تقرؤه دون إسقاطه — إسقاط الحقول داخلها غير مدعوم في كل
   محرّكات MongoDB المتوافقة — ثم يُحذف هنا قبل الإرسال. */
orderSchema.pre(['findOneAndUpdate'], function includeTokenInternally() {
  this.select('+trackingToken');
});
orderSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.trackingToken;
    return ret;
  },
});

// فهارس الإحصائيات وسجل الطلبات والتوصيل — تُبنى في الخلفية ولا تمس البيانات
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ orderType: 1, source: 1, createdAt: -1 });
orderSchema.index({ driver: 1, createdAt: -1 });
orderSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
