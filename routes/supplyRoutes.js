const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/supplyController');

const can = requirePermission('supplies:manage');
router.get('/', protect, can, c.listSupplies);
router.post('/', protect, can, c.addSupply);
router.patch('/:id', protect, can, c.updateSupply);
router.delete('/:id', protect, can, c.deleteSupply);

module.exports = router;
