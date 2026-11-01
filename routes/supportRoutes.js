const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { requireCustomer } = require('../middlewares/phoneAuth');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/supportController'));

// الصور: تُضغط في المتصفح (≤1600px) — حد الرفع 2MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const single = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'الصورة كبيرة جداً' : 'تعذّر رفع الصورة' });
});

// «تواصل مع فريق العمل» — الزبون برقم هاتفه (توكن type:'customer')
router.get('/me', requireCustomer, c.getMine);
router.get('/me/unread', requireCustomer, c.myUnread);
router.post('/me/read', requireCustomer, c.markMineRead);
router.get('/me/orders', requireCustomer, c.myOrders);
router.post('/me/messages', requireCustomer, c.sendMine);
router.post('/me/media', requireCustomer, single, c.uploadMine);
router.get('/me/media/:id', requireCustomer, c.mineMedia);

// الطاقم: من يملك «رسائل الزبائن» (support:reply)
const staff = [protect, requirePermission('support:reply')];
router.get('/unread', ...staff, c.staffUnread);
router.get('/stats', ...staff, c.stats);
router.get('/agents', ...staff, c.agents);
router.get('/settings', ...staff, c.getSettings);
router.put('/settings', protect, requirePermission('settings:manage'), c.saveSettings);
router.get('/threads', ...staff, c.listThreads);
router.get('/threads/:id', ...staff, c.getThread);
router.post('/threads/:id/messages', ...staff, c.reply);
router.post('/threads/:id/notes', ...staff, c.note);
router.post('/threads/:id/media', ...staff, single, c.staffUpload);
router.patch('/threads/:id', ...staff, c.update);
router.delete('/messages/:id', ...staff, c.deleteMessage);
router.get('/media/:id', ...staff, c.staffMedia);

module.exports = router;
