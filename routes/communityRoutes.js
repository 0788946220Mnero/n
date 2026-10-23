const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { requireCustomer } = require('../middlewares/phoneAuth');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/communityController'));

// الصورة الشخصية: تُصغَّر في المتصفح (≈256px) — حد الرفع 1MB، والمتحكّم يقبل حتى 600KB بعد التحقق
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });
const single = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'الصورة كبيرة جداً' : 'تعذّر رفع الصورة' });
});

// الصورة الشخصية عامة داخل الدردشة (بلا دخول — تُعرض في <img>)
router.get('/avatar/:id', c.avatar);

// الزبون (دخول برقم الهاتف)
router.get('/me', requireCustomer, c.getMe);
router.put('/me', requireCustomer, c.updateMe);
router.post('/me/avatar', requireCustomer, single, c.uploadAvatar);
router.delete('/me/avatar', requireCustomer, c.removeAvatar);
router.get('/messages', requireCustomer, c.list);
router.post('/messages', requireCustomer, c.post);
router.delete('/messages/:id', requireCustomer, c.removeOwn);
router.post('/messages/:id/report', requireCustomer, c.report);

// الإشراف: فريق العمل بصلاحية community:moderate
const mod = [protect, requirePermission('community:moderate')];
router.get('/admin/messages', ...mod, c.adminList);
router.post('/admin/messages', ...mod, c.adminPost);
router.delete('/admin/messages/:id', ...mod, c.adminDelete);
router.post('/admin/messages/:id/restore', ...mod, c.adminRestore);
router.get('/admin/members', ...mod, c.adminMembers);
router.post('/admin/members/:id/ban', ...mod, c.adminBan);
router.delete('/admin/members/:id/ban', ...mod, c.adminUnban);
router.delete('/admin/members/:id/avatar', ...mod, c.adminRemoveAvatar);
router.delete('/admin/members/:id/name', ...mod, c.adminResetName);
router.get('/admin/settings', ...mod, c.adminGetSettings);
router.put('/admin/settings', ...mod, c.adminSaveSettings);

module.exports = router;
