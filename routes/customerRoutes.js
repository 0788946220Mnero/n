const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const { getCustomers, updateCustomer, verifyCustomer, unverifyCustomer } = require('../controllers/customerController');

router.get('/', protect, getCustomers);
router.patch('/:id/verify', protect, authorize('admin', 'manager', 'cashier'), verifyCustomer);
router.patch('/:id/unverify', protect, authorize('admin', 'manager', 'cashier'), unverifyCustomer);
router.put('/:id', protect, authorize('admin', 'manager'), updateCustomer);

module.exports = router;
