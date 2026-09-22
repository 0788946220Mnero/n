const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const upload = require('../middlewares/upload');
const {
  subscribe,
  unsubscribe,
  getActiveNotification,
  getDiagnostics,
  sendTest,
  getNotifications,
  createNotification,
  resendNotification,
  deleteNotification,
  reactivateSubscribers,
} = require('../controllers/notificationController');

// ── عامة: صفحة الزبائن (بلا تسجيل دخول) ──
router.post('/subscribe', subscribe);
router.post('/unsubscribe', unsubscribe);
router.get('/active', getActiveNotification);

// ── لوحة التحكم ──
// تشخيص: لماذا لا تصل الإشعارات؟ — يجب أن يسبق /:id
router.get('/diagnostics', protect, authorize('admin', 'manager'), getDiagnostics);
router.post('/test', protect, authorize('admin', 'manager'), sendTest);
router.post('/reactivate-subscribers', protect, authorize('admin', 'manager'), reactivateSubscribers);

router.get('/', protect, authorize('admin', 'manager'), getNotifications);
router.post('/', protect, authorize('admin', 'manager'), createNotification);
router.post('/:id/resend', protect, authorize('admin', 'manager'), resendNotification);

// رفع صورة الإشعار إلى Cloudinary (نفس وسيط صور المنتجات: ضغط وتصغير تلقائي)؛
// يعيد الرابط ليُرسل في حقل image عند إنشاء الإشعار
router.post('/upload-image', protect, authorize('admin', 'manager'), upload.single('image'), (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ success: false, message: 'لم تصل صورة — اختر ملف jpg أو png أو webp' });
  }
  res.json({ success: true, url: req.file.path });
});
router.delete('/:id', protect, authorize('admin', 'manager'), deleteNotification);

module.exports = router;
