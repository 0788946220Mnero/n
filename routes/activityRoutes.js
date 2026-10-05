const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/activityController'));

router.get('/actions', protect, requirePermission('activity:view'), c.listActions);
router.get('/', protect, requirePermission('activity:view'), c.listActivity);

module.exports = router;
