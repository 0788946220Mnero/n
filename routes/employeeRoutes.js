const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/employeeController');

const can = requirePermission('employees:manage');
router.get('/', protect, can, c.listEmployees);
router.post('/', protect, can, c.createEmployee);
router.put('/:id', protect, can, c.updateEmployee);
router.get('/:id/payments', protect, can, c.employeePayments);

module.exports = router;
