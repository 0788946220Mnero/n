const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
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
} = require('../controllers/notificationController');

// ── عامة: صفحة الزبائن (بلا تسجيل دخول) ──
router.post('/subscribe', subscribe);
router.post('/unsubscribe', unsubscribe);
router.get('/active', getActiveNotification);

// ── لوحة التحكم ──
// تشخيص: لماذا لا تصل الإشعارات؟ — يجب أن يسبق /:id
router.get('/diagnostics', protect, authorize('admin', 'manager'), getDiagnostics);
router.post('/test', protect, authorize('admin', 'manager'), sendTest);

router.get('/', protect, authorize('admin', 'manager'), getNotifications);
router.post('/', protect, authorize('admin', 'manager'), createNotification);
router.post('/:id/resend', protect, authorize('admin', 'manager'), resendNotification);
router.delete('/:id', protect, authorize('admin', 'manager'), deleteNotification);

module.exports = router;
