const express = require('express');
const router = express.Router();
const upload = require('../middlewares/upload');
const { protect, authorize } = require('../middlewares/auth');
const { optimizeImages } = require('../middlewares/imageOptimizer');
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  toggleAvailability,
} = require('../controllers/productController');

const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 5 },
]);

router.get('/', getProducts);
router.get('/:id', getProduct);
router.post('/', protect, authorize('admin', 'manager'), uploadFields, optimizeImages, createProduct);
router.put('/:id', protect, authorize('admin', 'manager'), uploadFields, optimizeImages, updateProduct);
router.patch('/:id/availability', protect, authorize('admin', 'manager', 'cashier'), toggleAvailability);
router.delete('/:id', protect, authorize('admin', 'manager'), deleteProduct);

module.exports = router;
