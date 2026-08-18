const Setting = require('../models/Setting');

// جلب سجل الإعدادات الوحيد؛ يُنشئ سجلاً افتراضياً إن لم يوجد
const getOrCreateSettings = async () => {
  let settings = await Setting.findOne();
  if (!settings) {
    settings = await Setting.create({});
  }
  // رجوع تلقائي لوضع "مفتوح" عند انتهاء وقت الانشغال المحدّد
  if (
    settings.restaurantStatus &&
    settings.restaurantStatus.mode === 'busy' &&
    settings.restaurantStatus.busyUntil &&
    Date.now() > new Date(settings.restaurantStatus.busyUntil).getTime()
  ) {
    settings.restaurantStatus.mode = 'open';
    settings.restaurantStatus.busyUntil = null;
    await settings.save();
  }
  return settings;
};

// GET /api/settings — عام (لا يحتاج تسجيل دخول)، تستخدمه واجهة الموقع
const getSettings = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ message: 'تعذر جلب الإعدادات', error: err.message });
  }
};

// PUT /api/settings — محمي (أدمن/مدير فقط)
// يقبل تحديثاً جزئياً لأي حقل من حقول الإعدادات
const updateSettings = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const updatable = [
      'restaurantName', 'logo', 'workHours', 'workHoursNote',
      'phones', 'whatsapp', 'complaintsWhatsapp', 'mapUrl', 'location',
      'facebook', 'instagram', 'tiktok', 'deliveryFee', 'minOrderAmount',
      'aboutTitle', 'aboutText', 'aboutImage',
      'heroBackgroundEnabled', 'heroBackgroundType', 'heroBackgroundUrl',
      'specialOffer',
      'delivery',
    ];

    updatable.forEach((field) => {
      if (req.body[field] !== undefined) {
        let value = req.body[field];
        // بعض الحقول (workHours, phones) تصل كنص JSON عند الإرسال كـ FormData
        if ((field === 'workHours' || field === 'phones') && typeof value === 'string') {
          try { value = JSON.parse(value); } catch (e) { /* تجاهل، يبقى كما هو */ }
        }
        settings[field] = value;
      }
    });

    await settings.save();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حفظ الإعدادات', error: err.message });
  }
};

// POST /api/settings/about-image — رفع صورة "نبذة عنا"
const uploadAboutImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق صورة' });

    const settings = await getOrCreateSettings();
    settings.aboutImage = req.file.path;
    await settings.save();
    res.json({ success: true, aboutImage: settings.aboutImage });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر رفع الصورة', error: err.message });
  }
};

// POST /api/settings/hero-background — رفع صورة أو فيديو خلفية الصفحة الرئيسية
const uploadHeroBackground = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق ملف' });

    const settings = await getOrCreateSettings();
    const isVideo = /^video\//i.test(req.file.mimetype || '') || /\.(mp4|webm|mov)$/i.test(req.file.originalname || '');
    settings.heroBackgroundUrl = req.file.path;
    settings.heroBackgroundType = isVideo ? 'video' : 'image';
    await settings.save();
    res.json({ success: true, heroBackgroundUrl: settings.heroBackgroundUrl, heroBackgroundType: settings.heroBackgroundType });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر رفع الملف', error: err.message });
  }
};

// DELETE /api/settings/hero-background — حذف خلفية الصفحة الرئيسية وتعطيلها
const deleteHeroBackground = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    settings.heroBackgroundUrl = '';
    settings.heroBackgroundEnabled = false;
    await settings.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حذف الخلفية', error: err.message });
  }
};

/* ═══════════════════════════════════════════
   معرض الصور (Gallery) — إدارة كاملة من لوحة التحكم
═══════════════════════════════════════════ */

// POST /api/settings/gallery — رفع صورة جديدة إلى المعرض
const addGalleryImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق صورة' });

    const settings = await getOrCreateSettings();
    const maxOrder = settings.gallery.reduce((max, img) => Math.max(max, img.order || 0), -1);
    const isFirstImage = settings.gallery.length === 0;

    settings.gallery.push({
      url: req.file.path,
      order: maxOrder + 1,
      isMain: isFirstImage, // أول صورة تُرفع تصبح الصورة الرئيسية تلقائياً
    });

    await settings.save();
    res.json({ success: true, gallery: settings.gallery });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر رفع الصورة', error: err.message });
  }
};

// PUT /api/settings/gallery/:imageId — استبدال صورة موجودة بصورة جديدة
const replaceGalleryImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق صورة' });

    const settings = await getOrCreateSettings();
    const image = settings.gallery.id(req.params.imageId);
    if (!image) return res.status(404).json({ success: false, message: 'الصورة غير موجودة' });

    image.url = req.file.path;
    await settings.save();
    res.json({ success: true, gallery: settings.gallery });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر استبدال الصورة', error: err.message });
  }
};

// DELETE /api/settings/gallery/:imageId — حذف صورة من المعرض
const deleteGalleryImage = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const image = settings.gallery.id(req.params.imageId);
    if (!image) return res.status(404).json({ success: false, message: 'الصورة غير موجودة' });

    const wasMain = image.isMain;
    image.deleteOne();

    // إذا حُذفت الصورة الرئيسية، اجعل أول صورة متبقية هي الرئيسية
    if (wasMain && settings.gallery.length) {
      settings.gallery.sort((a, b) => a.order - b.order)[0].isMain = true;
    }

    await settings.save();
    res.json({ success: true, gallery: settings.gallery });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حذف الصورة', error: err.message });
  }
};

// PUT /api/settings/gallery/reorder — إعادة ترتيب صور المعرض
// يستقبل مصفوفة من معرّفات الصور بالترتيب المطلوب: { order: [id1, id2, id3, ...] }
const reorderGallery = async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'ترتيب غير صالح' });

    const settings = await getOrCreateSettings();
    order.forEach((imageId, index) => {
      const image = settings.gallery.id(imageId);
      if (image) image.order = index;
    });

    await settings.save();
    res.json({ success: true, gallery: settings.gallery });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حفظ الترتيب', error: err.message });
  }
};

// PUT /api/settings/gallery/:imageId/main — تحديد الصورة الرئيسية
const setMainGalleryImage = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const target = settings.gallery.id(req.params.imageId);
    if (!target) return res.status(404).json({ success: false, message: 'الصورة غير موجودة' });

    settings.gallery.forEach((img) => { img.isMain = false; });
    target.isMain = true;

    await settings.save();
    res.json({ success: true, gallery: settings.gallery });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر تحديد الصورة الرئيسية', error: err.message });
  }
};


/* ═══════════════════════════════════════════
   بانرات المينيو — زر "مينيو" في الصفحة الرئيسية
═══════════════════════════════════════════ */

// POST /api/settings/menu-banners — رفع بانر جديد للمينيو
const addMenuBanner = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق صورة' });

    const settings = await getOrCreateSettings();
    const maxOrder = (settings.menuBanners || []).reduce((max, b) => Math.max(max, b.order || 0), -1);
    settings.menuBanners.push({ url: req.file.path, order: maxOrder + 1 });

    await settings.save();
    res.json({ success: true, menuBanners: settings.menuBanners });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر رفع البانر', error: err.message });
  }
};

// DELETE /api/settings/menu-banners/:bannerId — حذف بانر من المينيو
const deleteMenuBanner = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const banner = settings.menuBanners.id(req.params.bannerId);
    if (!banner) return res.status(404).json({ success: false, message: 'البانر غير موجود' });

    banner.deleteOne();
    await settings.save();
    res.json({ success: true, menuBanners: settings.menuBanners });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حذف البانر', error: err.message });
  }
};

// PATCH /api/settings/status — تغيير حالة المطعم (مفتوح/مشغول/متوقف)
// body: { mode: 'open'|'busy'|'stopped', busyMinutes?: number, message?: string }
const updateRestaurantStatus = async (req, res) => {
  try {
    const { mode, busyMinutes, message } = req.body;
    if (!['open', 'busy', 'stopped'].includes(mode)) {
      return res.status(400).json({ message: 'حالة غير صحيحة' });
    }
    const settings = await getOrCreateSettings();
    settings.restaurantStatus.mode = mode;
    settings.restaurantStatus.message = message || '';
    if (mode === 'busy' && busyMinutes && Number(busyMinutes) > 0) {
      settings.restaurantStatus.busyUntil = new Date(Date.now() + Number(busyMinutes) * 60000);
    } else {
      settings.restaurantStatus.busyUntil = null;
    }
    await settings.save();
    res.json({ success: true, restaurantStatus: settings.restaurantStatus });
  } catch (err) {
    res.status(500).json({ message: 'تعذر تحديث حالة المطعم', error: err.message });
  }
};


// ═══════════ ريلز المطعم (فيديوهات قصيرة) ═══════════

// POST /api/settings/reels — رفع ريل جديد (فيديو + وصف)
const addReel = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق فيديو' });

    const settings = await getOrCreateSettings();
    const maxOrder = settings.reels.length
      ? Math.max(...settings.reels.map((r) => r.order || 0))
      : 0;

    settings.reels.push({
      url: req.file.path,
      caption: (req.body.caption || '').trim(),
      order: maxOrder + 1,
      publicId: req.file.filename || '',
    });
    await settings.save();
    res.json({ success: true, reels: settings.reels });
  } catch (err) {
    console.error('addReel error:', err);
    res.status(500).json({ success: false, message: 'تعذر رفع الريل' });
  }
};

// PUT /api/settings/reels/:reelId — تعديل وصف الريل
const updateReel = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const reel = settings.reels.id(req.params.reelId);
    if (!reel) return res.status(404).json({ success: false, message: 'الريل غير موجود' });

    if (typeof req.body.caption === 'string') reel.caption = req.body.caption.trim();
    if (req.body.order != null) reel.order = Number(req.body.order);
    await settings.save();
    res.json({ success: true, reels: settings.reels });
  } catch (err) {
    console.error('updateReel error:', err);
    res.status(500).json({ success: false, message: 'تعذر تعديل الريل' });
  }
};

// DELETE /api/settings/reels/:reelId — حذف ريل
const deleteReel = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const reel = settings.reels.id(req.params.reelId);
    if (!reel) return res.status(404).json({ success: false, message: 'الريل غير موجود' });

    reel.deleteOne();
    await settings.save();
    res.json({ success: true, reels: settings.reels });
  } catch (err) {
    console.error('deleteReel error:', err);
    res.status(500).json({ success: false, message: 'تعذر حذف الريل' });
  }
};

// ═══════════ شعار المطعم ═══════════
// POST /api/settings/logo — رفع/استبدال اللوغو (يُحفظ على Cloudinary بشكل دائم)
const uploadLogo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم إرفاق صورة' });

    const settings = await getOrCreateSettings();
    settings.logo = req.file.path;
    await settings.save();
    res.json({ success: true, logo: settings.logo });
  } catch (err) {
    console.error('uploadLogo error:', err);
    res.status(500).json({ success: false, message: 'تعذر رفع الشعار' });
  }
};

// DELETE /api/settings/logo — حذف الشعار
const deleteLogo = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    settings.logo = '';
    await settings.save();
    res.json({ success: true });
  } catch (err) {
    console.error('deleteLogo error:', err);
    res.status(500).json({ success: false, message: 'تعذر حذف الشعار' });
  }
};


// ═══════════ معاينة رسوم التوصيل (عام — يستخدمه موقع الزبائن) ═══════════
// POST /api/settings/delivery-quote  { latitude, longitude }
// يعيد المسافة والرسوم قبل تأكيد الطلب. الحساب هنا مطابق تماماً لحساب إنشاء الطلب.
const getDeliveryQuote = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const settings = await getOrCreateSettings();
    const d = settings.delivery || {};

    if (d.enabled === false) {
      return res.json({ success: false, code: 'DELIVERY_DISABLED', message: 'خدمة التوصيل متوقفة حالياً.' });
    }
    if (typeof d.restaurantLatitude !== 'number' || typeof d.restaurantLongitude !== 'number') {
      return res.json({
        success: false,
        code: 'RESTAURANT_LOCATION_MISSING',
        message: 'لم يتم تحديد موقع المطعم بعد. يرجى التواصل مع المطعم.',
      });
    }

    const { quoteDelivery } = require('../services/deliveryFeeService');
    const quote = await quoteDelivery({
      restaurantLat: d.restaurantLatitude,
      restaurantLng: d.restaurantLongitude,
      customerLat: Number(latitude),
      customerLng: Number(longitude),
      settings: d,
    });

    if (!quote.ok) {
      const messages = {
        OUT_OF_RANGE: `الموقع خارج نطاق التوصيل (الحد الأقصى ${quote.maxDistanceKm} كم).`,
        INVALID_COORDINATES: 'الموقع غير صالح. الرجاء تحديده من جديد.',
        CUSTOMER_LOCATION_MISSING: 'الرجاء تحديد موقع التوصيل على الخريطة.',
      };
      return res.json({
        success: false,
        code: quote.reason,
        message: messages[quote.reason] || 'تعذّر حساب رسوم التوصيل.',
        distanceKm: quote.distanceKm,
        maxDistanceKm: quote.maxDistanceKm,
      });
    }

    res.json({
      success: true,
      distanceKm: quote.distanceKm,
      fee: quote.fee,
      isFree: quote.fee === 0,
      freeDistanceKm: Number(d.freeDistanceKm ?? 1),
      maxDistanceKm: quote.maxDistanceKm,
    });
  } catch (err) {
    console.error('getDeliveryQuote error:', err);
    res.status(500).json({ success: false, message: 'تعذّر حساب رسوم التوصيل' });
  }
};

// GET /api/settings/delivery-config — إعدادات التوصيل العامة لموقع الزبائن
const getDeliveryConfig = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const d = settings.delivery || {};
    res.json({
      success: true,
      enabled: d.enabled === true,
      restaurantLatitude: d.restaurantLatitude ?? null,
      restaurantLongitude: d.restaurantLongitude ?? null,
      freeDistanceKm: Number(d.freeDistanceKm ?? 1),
      pricePerKm: Number(d.pricePerKm ?? 0.5),
      maxDistanceKm: Number(d.maxDistanceKm ?? 10),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذّر جلب إعدادات التوصيل' });
  }
};

module.exports = {
  getDeliveryQuote,
  getDeliveryConfig,
  addReel,
  updateReel,
  deleteReel,
  uploadLogo,
  deleteLogo,
  updateRestaurantStatus,
  getSettings,
  updateSettings,
  uploadAboutImage,
  uploadHeroBackground,
  deleteHeroBackground,
  addGalleryImage,
  replaceGalleryImage,
  deleteGalleryImage,
  reorderGallery,
  setMainGalleryImage,
  addMenuBanner,
  deleteMenuBanner,
};
