const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/shiftController'));

// فتح الجرد: يسجّل وقت البداية فقط (بلا أرقام) — لمن يعمل على الطلبات أيضاً، أما الإغلاق فلمدير النظام
router.post('/open', protect, requirePermission('orders:closeShift', 'shifts:view', 'orders:manage'), c.openShift);
router.get('/current', protect, c.getCurrentShift);
// السجل: الكل لمن يملك shifts:view، ودوراته فقط لمن يملك orders:closeShift
router.get('/', protect, requirePermission('shifts:view', 'orders:closeShift'), c.listShifts);
router.get('/:id', protect, requirePermission('shifts:view', 'orders:closeShift'), c.getShift);

module.exports = router;
