const express = require('express');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/liveReportController');

const router = express.Router();
const can = requirePermission('stats:live');

router.get('/key', c.getKey);
router.post('/subscribe', protect, can, c.subscribe);
router.delete('/subscribe', protect, c.unsubscribe);
router.post('/send-now', protect, can, c.sendNow);

module.exports = router;
