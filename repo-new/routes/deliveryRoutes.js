const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/deliveryController'));

// نظام التوصيل: من يملك delivery:manage، أو إدارة الطلبات (توافقاً مع الصلاحيات المخصّصة القديمة)
const canDelivery = requirePermission('delivery:manage', 'orders:manage');

router.get('/map', protect, canDelivery, c.getMap);
// إزالة الطلبات العالقة من جرد سابق: صلاحية إدارة الخريطة فقط (تُفرض هنا لا في الواجهة)
router.post('/map/clean', protect, requirePermission('delivery:mapManage'), c.cleanMap);
router.get('/history', protect, canDelivery, c.getHistory);
router.get('/drivers', protect, canDelivery, c.getDrivers);
router.get('/drivers/:id', protect, canDelivery, c.getDriver);

module.exports = router;
