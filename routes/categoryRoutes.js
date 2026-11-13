const express = require('express');
const router = express.Router();
const upload = require('../middlewares/upload');
const { protect, authorize } = require('../middlewares/auth');
const { optimizeImages } = require('../middlewares/imageOptimizer');
const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
} = require('../controllers/categoryController');

router.get('/', getCategories);
router.get('/:id', getCategory);
router.post('/', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, createCategory);
router.put('/reorder', protect, authorize('admin', 'manager'), reorderCategories);
router.put('/:id', protect, authorize('admin', 'manager'), upload.single('image'), optimizeImages, updateCategory);
router.delete('/:id', protect, authorize('admin', 'manager'), deleteCategory);

module.exports = router;
