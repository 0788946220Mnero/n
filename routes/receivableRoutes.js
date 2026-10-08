const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/receivableController');

const can = requirePermission('receivables:manage');
router.get('/', protect, can, c.listReceivables);
router.get('/drawers', protect, can, c.listDrawers); // قبل /:id
router.post('/', protect, can, c.createReceivable);
router.get('/:id', protect, can, c.getReceivable);
router.post('/:id/pay', protect, can, c.payReceivable);
// التراجع والإزالة: مدير النظام وحده (يُفرض داخل المتحكّم بالدور)
router.post('/:id/unpay', protect, can, c.unpayReceivable);
router.delete('/:id', protect, c.deleteReceivable);

module.exports = router;
