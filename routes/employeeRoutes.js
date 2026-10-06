const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/employeeController');

const can = requirePermission('employees:manage');
// من يصرف يحتاج قائمة الموظفين وسجل صرفهم، دون إضافتهم أو تعديلهم
const canSee = requirePermission('employees:manage', 'employees:pay');
router.get('/', protect, canSee, c.listEmployees);
router.post('/', protect, can, c.createEmployee);
router.put('/:id', protect, can, c.updateEmployee);
router.get('/:id/payments', protect, canSee, c.employeePayments);

module.exports = router;
