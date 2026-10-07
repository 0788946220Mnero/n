const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const { printOrAdmin } = require('../middlewares/printOrAdmin');
const {
  getOrders,
  getOrder,
  createOrder,
  confirmOrder,
  updateOrderStatus,
  getDashboardStats,
  getPrintQueue,
  createPosOrder,
  markPrinted,
  getBlockedPhones,
  blockPhone,
  unblockPhone,
  getShiftSummary,
  getShiftOverview,
  closeShift,
  getDrivers,
  assignDriver,
  markDeliverySent,
  setPaymentMethod,
  trackOrder,
  trackBatch,
  myOrders,
} = require('../controllers/orderController');
const { requirePermission } = require('../middlewares/permission');
const { requireCustomer } = require('../middlewares/phoneAuth');
const rateLimit = require('express-rate-limit');

// تتبع الزبون عام برمز سري — مع حد للطلبات يمنع التخمين
const trackLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

// برنامج الطابعة المحلي (بطاقة طباعة، لا JWT)
// بيع مباشر من تطبيق DiyarPOS — للكاشير فما فوق
router.post('/pos', protect, authorize('admin', 'manager', 'cashier'), createPosOrder);

router.get('/print-queue', printOrAdmin, getPrintQueue);
router.put('/:id/printed', printOrAdmin, markPrinted);

// حظر الأرقام (لوحة التحكم)
router.get('/blocked-list', protect, getBlockedPhones);
router.post('/block', protect, authorize('admin', 'manager', 'cashier'), blockPhone);
router.delete('/block/:phone', protect, authorize('admin', 'manager', 'cashier'), unblockPhone);

// الجرد لكل مستخدم: الكاشير يُغلق جرده هو، والمدير يستطيع جرد المطعم كاملاً
router.get('/shift-summary', protect, getShiftSummary);
router.get('/shift-overview', protect, authorize('admin', 'manager'), getShiftOverview);
router.post('/close-shift', protect, authorize('admin', 'manager', 'cashier'), closeShift);

// الزبون: تتبع طلبه وسجل طلباته — قبل /:id
router.post('/track', trackLimiter, trackBatch);
router.get('/track/:id', trackLimiter, trackOrder);
router.get('/my', requireCustomer, myOrders);
// رسالة الزبون على طلبه (تذكير/ملاحظة/إضافة أصناف) — برمز التتبع، وبحد أشد
const { createRequest, resolveRequest } = require('../controllers/orderRequestController');
const requestLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'رسائل كثيرة خلال وقت قصير — انتظر دقيقة' } });
router.post('/track/:id/request', requestLimiter, createRequest);

// المندوبون: القائمة قبل /:id حتى لا تُفسَّر «drivers» معرّفاً
router.get('/drivers', protect, getDrivers);
router.get('/stats/dashboard', protect, getDashboardStats);
router.get('/', protect, getOrders);
router.get('/:id', protect, getOrder);
router.post('/', createOrder); // يمكن إنشاؤه من الموقع العام بدون توكن — يُنشأ دائماً بحالة "معلّق"
router.put('/:id/confirm', protect, authorize('admin', 'manager', 'cashier'), confirmOrder);
router.put('/:id/status', protect, authorize('admin', 'manager', 'cashier'), updateOrderStatus);
// تعيين المندوب وإرسال التفاصيل: لمن يملك نظام التوصيل أو إدارة الطلبات (التوافق مع الصلاحيات المخصّصة القديمة)
router.put('/:id/driver', protect, requirePermission('delivery:manage', 'orders:manage'), assignDriver);
router.post('/:id/delivery-sent', protect, requirePermission('delivery:manage', 'orders:manage'), markDeliverySent);
router.put('/:id/payment', protect, requirePermission('orders:manage'), setPaymentMethod);
// الرد على رسائل الزبون: قبول الإضافة يغيّر الفاتورة → نفس من يغيّر حالة الطلب
router.put('/:id/requests/:rid', protect, authorize('admin', 'manager', 'cashier'), resolveRequest);

module.exports = router;
