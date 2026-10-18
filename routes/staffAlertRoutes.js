const express = require('express');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/staffAlertController');

const router = express.Router();
const admin = requirePermission('staff:notify'); // مدير النظام افتراضياً، ويُمنح لغيره

// كل مستخدم: تفعيل الإشعارات على جهازه وتجربتها
router.get('/key', c.getKey);
router.get('/devices/me', protect, c.myDevice);
router.post('/devices', protect, c.subscribe);
router.delete('/devices', protect, c.unsubscribe);
router.post('/test', protect, c.testMine);
router.post('/events', protect, c.reportEvent);

// مدير النظام: الإرسال والإعدادات والأجهزة والسجل
router.get('/', protect, admin, c.overview);
router.put('/settings', protect, admin, c.updateSettings);
router.post('/send', protect, admin, c.send);
router.delete('/devices/:id', protect, admin, c.removeDevice);

module.exports = router;
