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
    paymentMethod: { type: String, enum: ['cash', 'card', 'online'], default: 'cash' },
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
    // إغلاق الجرد: تُؤرشف الطلبات بدل حذفها (السجل المالي يبقى محفوظاً دائماً)
    closed: { type: Boolean, default: false, index: true },
    closedAt: { type: Date, default: null },
    shiftId: { type: String, default: '' },
    printRequested: { type: Boolean, default: false },
    printed: { type: Boolean, default: false },
    printedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
