const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/capitalController');

const can = requirePermission('capital:manage');
router.get('/', protect, can, c.getCapital);
router.post('/', protect, can, c.addEntry);
router.patch('/:id/void', protect, can, c.voidEntry);

module.exports = router;
