const express = require('express');
const router = express.Router();
const { audit } = require('../middlewares/activityLogger');

const { protect, authorize } = require('../middlewares/auth');
const { hasPermission } = require('../middlewares/permission');

/* تسجيل مصروف: الكاشير فما فوق — أو صرف لموظف لمن يملك «صرف للموظفين» أيّاً كان دوره
   (الصلاحية تُمنح من «المستخدمون»، فلا يحجبها الدور قبل أن تُفحص). */
const canCreateExpense = (req, res, next) => {
  if (['admin', 'manager', 'cashier'].includes(req.user.role)) return next();
  if (req.body && req.body.employee && hasPermission(req.user, 'employees:pay')) return next();
  return res.status(403).json({ success: false, message: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
};
const { createExpense, listExpenses,
  logExpenses, voidExpense, getSignature, setSignature, getExpense } = require('../controllers/expenseController');

// المصروفات: الكاشير فما فوق يسجّل، وكلٌّ يرى مصروفات جرده (والمدير الكل)
router.post('/', protect, canCreateExpense, audit('expense.create', (req) => ({ amount: Number(req.body.amount || 0), details: { name: String(req.body.name || '').slice(0, 120), source: req.body.source === 'capital' ? 'رأس المال' : 'الصندوق', ...(req.body.employee ? { employee: String(req.body.employeeName || req.body.paidTo || '') } : {}) } })), createExpense);
// توقيع مدير النظام لسندات الموظفين، والسند كاملاً للطباعة — قبل '/:id'
router.get('/signature', protect, getSignature);
router.put('/signature', protect, setSignature);
// سجل المصروف الكامل — قبل '/:id' وما شابه
router.get('/log', protect, authorize('admin', 'manager', 'cashier'), logExpenses);
router.get('/:id', protect, getExpense);
router.get('/', protect, authorize('admin', 'manager', 'cashier'), listExpenses);
router.patch('/:id/void', protect, authorize('admin', 'manager', 'cashier'), voidExpense);

module.exports = router;
