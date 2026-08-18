const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const { printAuth } = require('../middlewares/printAuth');
const { printOrAdmin } = require('../middlewares/printOrAdmin');
const {
  getOrders,
  getOrder,
  createOrder,
  confirmOrder,
  updateOrderStatus,
  getDashboardStats,
  getPrintQueue,
  markPrinted,
  getBlockedPhones,
  blockPhone,
  unblockPhone,
  getShiftSummary,
  closeShift,
} = require('../controllers/orderController');

// برنامج الطابعة المحلي (بطاقة طباعة، لا JWT)
router.get('/print-queue', printOrAdmin, getPrintQueue);
router.put('/:id/printed', printOrAdmin, markPrinted);

// حظر الأرقام (لوحة التحكم)
router.get('/blocked-list', protect, getBlockedPhones);
router.post('/block', protect, authorize('admin', 'manager', 'cashier'), blockPhone);
router.delete('/block/:phone', protect, authorize('admin', 'manager', 'cashier'), unblockPhone);

router.get('/shift-summary', protect, getShiftSummary);
router.post('/close-shift', protect, authorize('admin', 'manager'), closeShift);

router.get('/stats/dashboard', protect, getDashboardStats);
router.get('/', protect, getOrders);
router.get('/:id', protect, getOrder);
router.post('/', createOrder); // يمكن إنشاؤه من الموقع العام بدون توكن — يُنشأ دائماً بحالة "معلّق"
router.put('/:id/confirm', protect, authorize('admin', 'manager', 'cashier'), confirmOrder);
router.put('/:id/status', protect, authorize('admin', 'manager', 'cashier'), updateOrderStatus);

module.exports = router;
