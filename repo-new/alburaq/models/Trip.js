const mongoose = require('mongoose');
const { Schema } = mongoose;

const offerSchema = new Schema(
  {
    driver: { type: Schema.Types.ObjectId, ref: 'BrqDriver', required: true },
    wave: { type: Number, required: true },
    sentAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['sent', 'accepted', 'declined', 'expired', 'cancelled'],
      default: 'sent',
    },
  },
  { _id: false }
);

/**
 * نقطة تسليم (زبون). رقم الزبون إلزامي منذ إرسال الطلب. الموقع اختياري عند الطلب
 * (رابط مشاركة الموقع أو نقرة على الخريطة)، ويُسجَّل دائماً لحظة التسليم من GPS السائق.
 */
const stopSchema = new Schema({
  name: { type: String, default: '', maxlength: 80 },
  phone: { type: String, required: true },
  area: { type: Schema.Types.ObjectId, ref: 'BrqArea', default: null },
  areaName: { type: String, default: '' },
  areaCenter: { lat: Number, lng: Number },
  // الموقع المعروف مسبقاً (من رابط أو خريطة) — null إن لم يُحدَّد
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  locationSource: { type: String, default: '' }, // link | map | driver | store
  note: { type: String, default: '', maxlength: 200 },
  status: { type: String, enum: ['pending', 'delivered'], default: 'pending' },
  deliveredAt: { lat: Number, lng: Number },
  deliveredTime: { type: Date, default: null },
  deliveredAccuracy: { type: Number, default: null }, // دقة GPS السائق لحظة التسليم (متر)
  legKm: { type: Number, default: null },   // الكم الهوائي من النقطة السابقة (المتجر أو الزبون السابق)
  offsetM: { type: Number, default: null }, // بُعد التسليم عن الموقع المحدد مسبقاً (للمراجعة فقط، لا يمنع)
});

/** طلب سائق من متجر: يمر بالحالات searching → assigned → completed (أو expired / cancelled). */
const tripSchema = new Schema(
  {
    store: { type: Schema.Types.ObjectId, ref: 'BrqStore', required: true, index: true },
    storeName: { type: String, required: true },
    storeLocation: { lat: Number, lng: Number },

    // منطقة أول نقطة (للعرض)، والنقاط كلها في stops
    area: { type: Schema.Types.ObjectId, ref: 'BrqArea', default: null },
    areaName: { type: String, default: '' },
    areaCenter: { lat: Number, lng: Number },

    // بيانات الزبون — تحفظها الشركة دائماً لمنع تجاوز المنصة من السائق
    // بيانات الزبون — المتجر لا يُدخلها (يكفيه اختيار المنطقة).
    // تُستكمل عند التسليم: الموقع من GPS السائق لحظة التسليم، والرقم يُدخله السائق.
    // (الكول سنتر يستطيع إدخالها مسبقاً اختيارياً.) الشركة تحتفظ بها دائماً.
    customer: {
      name: { type: String, default: '', maxlength: 80 },
      phone: { type: String, default: '' },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    // نقاط التسليم — زبون واحد أو أكثر في الرحلة نفسها
    stops: { type: [stopSchema], default: [] },
    // التقدير عند الطلب: فتحة العداد + كم هوائي (المتجر ← النقاط بالترتيب) × سعر الكم
    estimateFils: { type: Number, default: null },
    // موقع آخر تسليم (GPS السائق)
    deliveredAt: { lat: Number, lng: Number },

    // مجموع الكم الهوائي: المتجر ← الزبون الأول ← الثاني … (يُحسب عند التسليم فقط)
    km: { type: Number, default: null },
    // التسعير النهائي (يُملأ عند التسليم)
    pricing: {
      meterFlagFils: Number,
      perKmFils: Number,
      companyCutPerKmFils: Number,
      distanceFils: Number,
      companyFils: Number,
      driverFils: Number,
      storeChargeFils: Number,
    },

    status: {
      type: String,
      // searching → assigned (سائق قبل) → picked (المتجر أكّد الاستلام، بدأت الرحلة) → completed (تم التسليم)
      enum: ['searching', 'assigned', 'picked', 'completed', 'expired', 'cancelled'],
      default: 'searching',
      index: true,
    },
    driver: { type: Schema.Types.ObjectId, ref: 'BrqDriver', default: null, index: true },
    driverName: { type: String, default: '' },

    wave: { type: Number, default: 0 },
    waveEndsAt: { type: Date, default: null },
    offers: { type: [offerSchema], default: [] },

    requestedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
    pickedAt: { type: Date, default: null },
    // الاستلام من المطعم: رمز يظهر على شاشة السائق ويُدخله المطعم، أو يؤكده السائق بنفسه
    pickupCode: { type: String, default: '' },
    pickupTries: { type: Number, default: 0 },
    pickupBy: { type: String, enum: ['', 'code', 'driver', 'store', 'admin'], default: '' },
    pickupPoint: { lat: Number, lng: Number },
    pickupOffsetM: { type: Number, default: null }, // بُعد السائق عن المطعم لحظة تأكيده بنفسه (للمراجعة فقط)
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    rated: { type: Boolean, default: false },
    // مصدر الطلب: متجر، كول سنتر البراق، أو طلب من مطعم البراق (حالة الطلبات: سنتر أو منصة)
    source: {
      kind: { type: String, enum: ['store', 'callcenter', 'restaurant'], default: 'store' },
      order: { type: Schema.Types.ObjectId, default: null }, // طلب المطعم (Order في ديار)
      orderNumber: { type: String, default: '' },
      channel: { type: String, default: '' },                // web | app | center
      by: { type: String, default: '' },                     // اسم من أرسله
    },
    receiptNo: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqTrip', tripSchema, 'brq_trips');
