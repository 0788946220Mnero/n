const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/centerController');

const sell = requirePermission('center:sell');
const watch = requirePermission('center:monitor');
// البحث برقم الزبون محدود: يمنع استعمال الحساب لتصفّح أرقام الزبائن
const lookupLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'بحث كثير خلال دقيقة — انتظر قليلاً' } });

router.post('/orders', protect, sell, c.createOrder);
router.get('/orders', protect, sell, c.listOrders);
router.get('/customers', protect, sell, lookupLimiter, c.lookupCustomer);
router.get('/monitor', protect, watch, c.monitor);
router.get('/monitor/:userId', protect, watch, c.monitorUser);

module.exports = router;
