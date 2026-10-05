const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/statsController'));

router.get('/overview', protect, requirePermission('stats:view'), c.getOverview);

module.exports = router;
