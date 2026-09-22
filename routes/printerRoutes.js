const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  getPrinters,
  createPrinter,
  updatePrinter,
  deletePrinter,
  setMainPrinter,
  togglePrinterActive,
  getRouting,
  setCategoryPrinter,
} = require('../controllers/printerController');

// ⚠️ مسارات routing يجب أن تسبق /:id وإلا فُسّرت "routing" على أنها معرّف طابعة
router.get('/routing', protect, getRouting);
router.patch('/routing/:categoryId', protect, authorize('admin', 'manager'), setCategoryPrinter);

// القراءة متاحة لكل مستخدم مسجّل — الكاشير يحتاج أسماء الطابعات ليطبع
router.get('/', protect, getPrinters);

router.post('/', protect, authorize('admin', 'manager'), createPrinter);
router.put('/:id', protect, authorize('admin', 'manager'), updatePrinter);
router.delete('/:id', protect, authorize('admin', 'manager'), deletePrinter);
router.patch('/:id/main', protect, authorize('admin', 'manager'), setMainPrinter);
router.patch('/:id/active', protect, authorize('admin', 'manager'), togglePrinterActive);

module.exports = router;
