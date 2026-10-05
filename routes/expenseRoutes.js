const express = require('express');
const router = express.Router();
const { audit } = require('../middlewares/activityLogger');

const { protect, authorize } = require('../middlewares/auth');
const { createExpense, listExpenses, voidExpense } = require('../controllers/expenseController');

// المصروفات: الكاشير فما فوق يسجّل، وكلٌّ يرى مصروفات جرده (والمدير الكل)
router.post('/', protect, authorize('admin', 'manager', 'cashier'), audit('expense.create', (req) => ({ amount: Number(req.body.amount || 0), details: { reason: String(req.body.reason || req.body.description || '').slice(0, 120) } })), createExpense);
router.get('/', protect, authorize('admin', 'manager', 'cashier'), listExpenses);
router.patch('/:id/void', protect, authorize('admin', 'manager', 'cashier'), voidExpense);

module.exports = router;
