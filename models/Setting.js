const mongoose = require('mongoose');

const workDaySchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // مثال: "السبت"
    isOpen: { type: Boolean, default: true },
    openTime: { type: String, default: '12:00' },
    closeTime: { type: String, default: '00:00' },
  },
  { _id: false }
);

const settingSchema = new mongoose.Schema(
  {
    restaurantName: { type: String, default: 'ديار الأنباط' },
    logo: { type: String, default: '' },

    // مواعيد العمل (تُدار بالكامل من لوحة التحكم)
    workHours: {
      type: [workDaySchema],
      default: [
        { day: 'السبت', isOpen: true, openTime: '12:00', closeTime: '00:00' },
        { day: 'الأحد', isOpen: true, openTime: '12:00', closeTime: '00:00' },
        { day: 'الاثنين', isOpen: true, openTime: '12:00', closeTime: '00:00' },
        { day: 'الثلاثاء', isOpen: true, openTime: '12:00', closeTime: '00:00' },
        { day: 'الأربعاء', isOpen: true, openTime: '12:00', closeTime: '00:00' },
        { day: 'الخميس', isOpen: true, openTime: '12:00', closeTime: '01:00' },
        { day: 'الجمعة', isOpen: true, openTime: '12:00', closeTime: '01:00' },
      ],
    },
    workHoursNote: { type: String, default: '' },

    phones: [{ type: String }],
    whatsapp: { type: String, default: '' }, // واتساب الطلبات العام
    complaintsWhatsapp: { type: String, default: '' }, // واتساب الشكاوى والاقتراحات (مدير المطعم)
    mapUrl: { type: String, default: '' }, // رابط خريطة المطعم على Google Maps

    // ═══ نظام التوصيل: موقع المطعم وإعدادات حساب الرسوم ═══
    delivery: {
      enabled: { type: Boolean, default: false },        // تفعيل/إيقاف التوصيل
      restaurantLatitude: { type: Number, default: null },
      restaurantLongitude: { type: Number, default: null },
      freeDistanceKm: { type: Number, default: 1 },      // المسافة المجانية
      pricePerKm: { type: Number, default: 0.5 },        // سعر كل كيلومتر إضافي
      maxDistanceKm: { type: Number, default: 10 },      // أقصى مسافة للتوصيل
      // 'straight' = مسافة جوية (Haversine) | 'road' = مسافة الطريق (تحتاج Routing API)
      distanceMode: { type: String, enum: ['straight', 'road'], default: 'straight' },
    },
    location: { type: String, default: '' },
    facebook: { type: String, default: '' },
    instagram: { type: String, default: '' },
    tiktok: { type: String, default: '' },
    deliveryFee: { type: Number, default: 0 },
    minOrderAmount: { type: Number, default: 0 },
    // العرض المميز (بطاقة "عرض اليوم") — تُدار من لوحة التحكم
    specialOffer: {
      enabled: { type: Boolean, default: false },
      name: { type: String, default: '' },
      desc: { type: String, default: '' },
      price: { type: Number, default: 0 },
      oldPrice: { type: Number, default: 0 },
    },
    // حالة المطعم لاستقبال الطلبات (تُدار من لوحة التحكم)
    restaurantStatus: {
      mode: { type: String, enum: ['open', 'busy', 'stopped'], default: 'open' },
      busyUntil: { type: Date, default: null },
      message: { type: String, default: '' },
    },

    // صفحة "نبذة عنا"
    aboutTitle: { type: String, default: 'نبذة عنا' },
    aboutText: { type: String, default: '' },
    aboutImage: { type: String, default: '' },

    // خلفية الصفحة الرئيسية (Hero) — صورة أو فيديو، تُدار من لوحة التحكم
    heroBackgroundEnabled: { type: Boolean, default: false },
    heroBackgroundType: { type: String, enum: ['image', 'video'], default: 'image' },
    heroBackgroundUrl: { type: String, default: '' },

    // بانرات المينيو — تظهر داخل زر "مينيو" في الصفحة الرئيسية كبانر متحرك
    // تُدار بالكامل من لوحة التحكم (قسم الإعدادات)
    menuBanners: {
      type: [
        {
          url: { type: String, required: true },
          order: { type: Number, default: 0 },
        },
      ],
      default: [],
    },

    // ريلز المطعم (فيديوهات قصيرة) — تُدار بالكامل من لوحة التحكم
    reels: {
      type: [
        {
          url: { type: String, required: true },   // رابط الفيديو على Cloudinary
          caption: { type: String, default: '' },  // الوصف النصي الذي يظهر مع الريل
          order: { type: Number, default: 0 },
          publicId: { type: String, default: '' }, // لحذف الملف من Cloudinary
        },
      ],
      default: [],
    },

    // معرض الصور (Gallery) — تُدار بالكامل من لوحة التحكم
    gallery: {
      type: [
        {
          url: { type: String, required: true },
          order: { type: Number, default: 0 },
          isMain: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
