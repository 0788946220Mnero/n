const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/chatController');

// دردشة الطاقم: كل من يملك «chat:use»، والإدارة لمدير النظام «chat:monitor»
const use = requirePermission('chat:use');
const monitor = requirePermission('chat:monitor');
// الوسائط في الذاكرة ثم القاعدة (صورة مضغوطة ≤1.6MB، صوت ≤3MB) — لا قرص ولا رابط عام
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });

router.get('/bootstrap', protect, use, c.bootstrap);
router.get('/conversations', protect, use, c.conversations);
router.get('/ice', protect, use, c.ice);
router.get('/calls/pending', protect, use, c.pendingCalls);
router.get('/admin', protect, monitor, c.admin);
router.put('/admin/settings', protect, monitor, c.adminSettings);
router.post('/conversations/direct', protect, use, c.openDirect);
router.post('/conversations/group', protect, use, c.createGroup);
router.patch('/conversations/:id', protect, use, c.updateConv);
router.delete('/conversations/:id', protect, use, c.removeConv);
router.post('/conversations/:id/leave', protect, use, c.leave);
router.get('/conversations/:id/messages', protect, use, c.messages);
router.post('/conversations/:id/messages', protect, use, c.send);
// خطأ الحجم من multer برسالة عربية بدل خطأ عام
const single = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  const big = err.code === 'LIMIT_FILE_SIZE';
  return res.status(big ? 413 : 400).json({ success: false, message: big ? 'الملف كبير جداً (الحد 3 ميغابايت)' : 'تعذّر قراءة الملف' });
});
router.post('/conversations/:id/media', protect, use, single, c.sendMedia);
router.post('/conversations/:id/read', protect, use, c.read);
router.delete('/messages/:id', protect, use, c.deleteMessage);
router.get('/media/:id', protect, use, c.media);

module.exports = router;
