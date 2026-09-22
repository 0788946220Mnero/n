const express = require('express');
const router = express.Router();
const upload = require('../middlewares/upload');
const { protect, authorize } = require('../middlewares/auth');
const { optimizeImages } = require('../middlewares/imageOptimizer');
const {
  getSettings,
  updateSettings,
  updateRestaurantStatus,
  getDeliveryQuote,
  getDeliveryConfig,
  addReel,
  updateReel,
  deleteReel,
  uploadLogo,
  deleteLogo,
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
} = require('../controllers/settingController');

// عام — تستخدمه واجهة الموقع لعرض نبذة عنا / مواعيد العمل / واتساب الشكاوى / الخريطة / خلفية الهيرو / معرض الصور
router.get('/', getSettings);
// التوصيل — مساران عامان يستخدمهما موقع الزبائن
router.get('/delivery-config', getDeliveryConfig);
router.post('/delivery-quote', getDeliveryQuote);

router.patch('/status', protect, authorize('admin', 'manager', 'cashier'), updateRestaurantStatus);

// محمي — لوحة التحكم فقط
router.put('/', protect, authorize('admin', 'manager'), updateSettings);
router.post('/about-image', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, uploadAboutImage);
router.post('/hero-background', protect, authorize('admin', 'manager'), upload.uploadMedia.single('media'), optimizeImages, uploadHeroBackground);
router.delete('/hero-background', protect, authorize('admin', 'manager'), deleteHeroBackground);

// معرض الصور (Gallery) — محمي، لوحة التحكم فقط
// ملاحظة: مسار /reorder يجب أن يسبق /:imageId حتى لا يُفسَّر "reorder" كمعرّف صورة
router.put('/gallery/reorder', protect, authorize('admin', 'manager'), reorderGallery);
router.post('/gallery', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, addGalleryImage);
router.put('/gallery/:imageId', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, replaceGalleryImage);
router.delete('/gallery/:imageId', protect, authorize('admin', 'manager'), deleteGalleryImage);
router.put('/gallery/:imageId/main', protect, authorize('admin', 'manager'), setMainGalleryImage);

// بانرات المينيو (زر "مينيو" في الصفحة الرئيسية) — محمي، لوحة التحكم فقط
// ريلز المطعم
router.post('/reels', protect, authorize('admin', 'manager'), upload.uploadMedia.single('video'), addReel);
router.put('/reels/:reelId', protect, authorize('admin', 'manager'), updateReel);
router.delete('/reels/:reelId', protect, authorize('admin', 'manager'), deleteReel);

// شعار المطعم
router.post('/logo', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, uploadLogo);
router.delete('/logo', protect, authorize('admin', 'manager'), deleteLogo);

router.post('/menu-banners', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, addMenuBanner);
router.delete('/menu-banners/:bannerId', protect, authorize('admin', 'manager'), deleteMenuBanner);

module.exports = router;
