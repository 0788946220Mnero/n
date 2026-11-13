/**
 * منصة براق — النماذج.
 *
 * الفكرة: كل متجر يعمل على خادمه الخاص (نسخة من خادم البراق على Railway) ويدير منتجاته
 * من لوحة تحكمه هو. المنصة لا تملك المنتجات: تسجّل عنوان خادم المتجر وتجلب منه
 * التصنيفات والمنتجات دورياً إلى نسخة مخبأة (MktProduct) للبحث والعرض السريع،
 * والطلب يُرسَل لخادم المتجر نفسه فيُسعَّر هناك ويظهر في لوحته ونقطة بيعه.
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;

const pointSchema = new Schema(
  { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], default: undefined } }, // [lng, lat]
  { _id: false }
);

const storeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: ['restaurant', 'store'], default: 'restaurant', index: true },
    tags: { type: [String], default: [] }, // شاورما، برغر، سوبرماركت…
    baseUrl: { type: String, required: true, trim: true }, // https://xxx.up.railway.app
    logo: { type: String, default: '' },
    cover: { type: String, default: '' },
    phone: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
    address: { type: String, default: '', maxlength: 160 },
    description: { type: String, default: '', maxlength: 400 },
    location: { type: pointSchema, default: undefined },
    active: { type: Boolean, default: true, index: true },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },

    // التوصيل: سائقو المتجر (تسعيرة المتجر من لوحته على خادمه) و/أو سائقو البراق (تسعيرة من لوحة البراق)
    delivery: {
      storeDrivers: { type: Boolean, default: true },
      buraqDrivers: { type: Boolean, default: false },
      pickup: { type: Boolean, default: true },
      // تسعيرة سائقي البراق لزبائن هذا المتجر: meter = تسعيرة البراق العامة، custom = تسعيرة خاصة
      buraqMode: { type: String, enum: ['meter', 'custom'], default: 'meter' },
      buraqBaseFils: { type: Number, default: 100, min: 0 },
      buraqPerKmFils: { type: Number, default: 25, min: 0 },
      buraqMaxKm: { type: Number, default: 15, min: 0 },
      brqStore: { type: Schema.Types.ObjectId, ref: 'BrqStore', default: null }, // متجر البراق المرتبط (لإنشاء رحلة)
    },

    // مفتاح بوابة المتجر (الرد على الزبائن ورؤية الطلبات والتقييمات) — يُخزَّن مُجزّأً
    keyHash: { type: String, default: '', select: false },
    keyHint: { type: String, default: '' },

    // آخر مزامنة
    sync: {
      at: { type: Date, default: null },
      ok: { type: Boolean, default: false },
      error: { type: String, default: '' },
      ms: { type: Number, default: 0 },
      products: { type: Number, default: 0 },
      categories: { type: Number, default: 0 },
    },
    // لقطة من إعدادات المتجر العامة (الحالة، ساعات العمل، التوصيل)
    remote: {
      restaurantName: { type: String, default: '' },
      status: { type: String, default: 'open' }, // open | busy | stopped
      statusMessage: { type: String, default: '' },
      deliveryEnabled: { type: Boolean, default: true },
      maxDistanceKm: { type: Number, default: null },
      workHoursNote: { type: String, default: '' },
      categories: [{ _id: false, id: String, name: String, nameEn: String, image: String, order: Number }],
    },
    rating: { count: { type: Number, default: 0 }, sum: { type: Number, default: 0 } },
    ordersCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
storeSchema.index({ location: '2dsphere' });

const productSchema = new Schema(
  {
    store: { type: Schema.Types.ObjectId, ref: 'MktStore', required: true, index: true },
    remoteId: { type: String, required: true },
    name: { type: String, default: '' },
    nameEn: { type: String, default: '' },
    description: { type: String, default: '' },
    price: { type: Number, default: 0 },
    oldPrice: { type: Number, default: null },
    image: { type: String, default: '' },
    images: { type: [String], default: [] },
    categoryId: { type: String, default: '' },
    categoryName: { type: String, default: '' },
    addons: [{ _id: false, name: String, price: Number }],
    available: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    popularity: { type: Number, default: 0 }, // ordersCount من خادم المتجر
    rating: { count: { type: Number, default: 0 }, sum: { type: Number, default: 0 } },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
productSchema.index({ store: 1, remoteId: 1 }, { unique: true });
productSchema.index({ name: 'text', nameEn: 'text', categoryName: 'text' });

const orderSchema = new Schema(
  {
    store: { type: Schema.Types.ObjectId, ref: 'MktStore', required: true, index: true },
    storeName: { type: String, default: '' },
    phoneUser: { type: Schema.Types.ObjectId, ref: 'PhoneUser', required: true, index: true },
    customerName: { type: String, default: '' },
    phone: { type: String, default: '' },
    orderType: { type: String, enum: ['delivery', 'pickup'], default: 'delivery' },
    deliveryBy: { type: String, enum: ['store', 'buraq', ''], default: '' },
    address: { type: String, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    items: [{ _id: false, remoteId: String, name: String, quantity: Number, price: Number, addons: [{ _id: false, name: String, price: Number }] }],
    itemsTotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // من خادم المتجر
    remoteId: { type: String, default: '' },
    orderNumber: { type: String, default: '' },
    trackingToken: { type: String, default: '', select: false },
    status: { type: String, default: 'pending' },
    statusLabel: { type: String, default: '' },
    statusAt: { type: Date, default: null },
    // رحلة البراق (عند التوصيل بسائقي البراق)
    brqTrip: { type: Schema.Types.ObjectId, ref: 'BrqTrip', default: null },
    brqError: { type: String, default: '' },
    reviewed: { type: Boolean, default: false },
    clientRef: { type: String, default: '' },
  },
  { timestamps: true }
);
orderSchema.index({ phoneUser: 1, createdAt: -1 });

const reviewSchema = new Schema(
  {
    store: { type: Schema.Types.ObjectId, ref: 'MktStore', required: true, index: true },
    product: { type: Schema.Types.ObjectId, ref: 'MktProduct', default: null, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'MktOrder', required: true },
    phoneUser: { type: Schema.Types.ObjectId, ref: 'PhoneUser', required: true, index: true },
    authorName: { type: String, default: 'زبون' },
    stars: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, default: '', maxlength: 500 },
    reply: { type: String, default: '', maxlength: 500 }, // رد المتجر
    replyAt: { type: Date, default: null },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);
// تقييم واحد للمتجر لكل طلب، وتقييم واحد لكل منتج لكل طلب
reviewSchema.index({ order: 1, product: 1 }, { unique: true });

const threadSchema = new Schema(
  {
    store: { type: Schema.Types.ObjectId, ref: 'MktStore', required: true, index: true },
    phoneUser: { type: Schema.Types.ObjectId, ref: 'PhoneUser', required: true, index: true },
    customerName: { type: String, default: '' },
    phone: { type: String, default: '' },
    lastText: { type: String, default: '' },
    lastAt: { type: Date, default: Date.now, index: true },
    unreadStore: { type: Number, default: 0 },
    unreadCustomer: { type: Number, default: 0 },
  },
  { timestamps: true }
);
threadSchema.index({ store: 1, phoneUser: 1 }, { unique: true });

const messageSchema = new Schema(
  {
    thread: { type: Schema.Types.ObjectId, ref: 'MktThread', required: true, index: true },
    from: { type: String, enum: ['customer', 'store', 'buraq'], required: true },
    byName: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true }
);
messageSchema.index({ thread: 1, createdAt: -1 });

/** إعدادات تطبيق براق (مستند واحد): مقدمة قبل شعار البدء — صورة أو فيديو لمدة قصيرة. */
const appConfigSchema = new Schema(
  {
    key: { type: String, default: 'app', unique: true },
    intro: {
      enabled: { type: Boolean, default: false },
      type: { type: String, enum: ['none', 'image', 'video'], default: 'none' },
      url: { type: String, default: '' },
      durationMs: { type: Number, default: 2000, min: 1000, max: 5000 },
      skippable: { type: Boolean, default: true },
    },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = {
  MktAppConfig: mongoose.models.MktAppConfig || mongoose.model('MktAppConfig', appConfigSchema, 'mkt_app_config'),
  MktStore: mongoose.models.MktStore || mongoose.model('MktStore', storeSchema, 'mkt_stores'),
  MktProduct: mongoose.models.MktProduct || mongoose.model('MktProduct', productSchema, 'mkt_products'),
  MktOrder: mongoose.models.MktOrder || mongoose.model('MktOrder', orderSchema, 'mkt_orders'),
  MktReview: mongoose.models.MktReview || mongoose.model('MktReview', reviewSchema, 'mkt_reviews'),
  MktThread: mongoose.models.MktThread || mongoose.model('MktThread', threadSchema, 'mkt_threads'),
  MktMessage: mongoose.models.MktMessage || mongoose.model('MktMessage', messageSchema, 'mkt_messages'),
};
