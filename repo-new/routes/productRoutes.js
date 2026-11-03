const express = require('express');
const router = express.Router();
const { audit } = require('../middlewares/activityLogger');

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
router.post('/', protect, authorize('admin', 'manager'), uploadFields, optimizeImages, audit('product.create', (req, body) => ({ details: { name: req.body.nameAr || '', productId: body && body._id ? String(body._id) : '' } })), createProduct);
router.put('/:id', protect, authorize('admin', 'manager'), uploadFields, optimizeImages, audit('product.update', (req) => ({ details: { productId: req.params.id, name: req.body.nameAr || '', price: req.body.price != null ? Number(req.body.price) : undefined } })), updateProduct);
router.patch('/:id/availability', protect, authorize('admin', 'manager', 'cashier'), toggleAvailability);
router.delete('/:id', protect, authorize('admin', 'manager'), audit('product.delete', (req) => ({ details: { productId: req.params.id } })), deleteProduct);

module.exports = router;
