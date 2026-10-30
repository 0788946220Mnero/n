const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/obligationController');

// الالتزامات الثابتة: الإنشاء والتعديل بتوقيع مدير النظام، والدفع اليومي للكاشير فما فوق
const canSee = requirePermission('obligations:manage', 'obligations:pay', 'obligations:view');
const canManage = requirePermission('obligations:manage');
const canPay = requirePermission('obligations:pay');

router.get('/', protect, canSee, c.list);
router.post('/', protect, canManage, c.create);
router.get('/:id', protect, canSee, c.getOne);
router.put('/:id', protect, canManage, c.update);
router.post('/:id/sign', protect, canManage, c.sign);
router.post('/:id/stop', protect, canManage, c.stop);
router.post('/:id/resume', protect, canManage, c.resume);
router.post('/:id/pay', protect, canPay, c.pay);
router.delete('/:id', protect, canManage, c.archive); // مدير النظام وحده (يُفرض في المتحكّم)

module.exports = router;
