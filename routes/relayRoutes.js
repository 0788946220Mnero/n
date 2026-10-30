const express = require('express');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/relayController');

const router = express.Router();
const sender = requirePermission('voice:commands');

router.get('/receivers', protect, c.listReceivers);
router.post('/receivers/heartbeat', protect, c.heartbeat);
router.get('/pending', protect, c.pending);
router.post('/', protect, sender, c.create);
router.get('/:id', protect, c.getOne);
router.post('/:id/claim', protect, c.claim);
router.post('/:id/done', protect, c.done);
router.post('/:id/cancel', protect, sender, c.cancel);

module.exports = router;
