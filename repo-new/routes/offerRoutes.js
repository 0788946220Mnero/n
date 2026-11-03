const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const upload = require('../middlewares/upload');
const c = require('../controllers/offerController');

// العروض الترويجية — انظر controllers/offerController.js
const can = requirePermission('offers:manage');
const files = upload.uploadMedia.fields([{ name: 'media', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

router.get('/public/:code', c.publicOne); // للموقع: بلا دخول
router.get('/', protect, can, c.list);
router.post('/', protect, can, files, c.create);
router.put('/:id', protect, can, files, c.update);
router.delete('/:id', protect, can, c.remove);

module.exports = router;
