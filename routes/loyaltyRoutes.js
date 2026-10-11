const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { requireCustomer } = require('../middlewares/phoneAuth');
const c = require('../controllers/loyaltyController');

const router = express.Router();
const lim = (max, windowMs = 60000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة — انتظر دقيقة' } });

// الزبون: عضويته هو فقط (من توكن OTP — لا معرّف في الرابط يمكن تغييره)
router.get('/me', lim(60), requireCustomer, c.me);
router.put('/me/name', lim(10), requireCustomer, c.myName);
router.get('/me/qr.svg', lim(60), requireCustomer, c.myQr);
router.post('/me/apple', lim(10), requireCustomer, c.myAppleLink);
router.post('/me/google', lim(10), requireCustomer, c.myGoogleLink);
router.get('/apple/download/:token', lim(20), c.appleDownload);

// الكاشير: البحث والمعاينة والتسجيل — بحدّ يمنع تخمين الأرقام والرموز
const use = requirePermission('loyalty:use', 'loyalty:manage');
router.get('/lookup', protect, use, lim(60), c.lookup);
router.post('/quote', protect, use, lim(120), c.quote);
router.post('/enroll', protect, use, lim(30), c.enroll);

// الإدارة
const manage = requirePermission('loyalty:manage');
router.get('/admin/accounts', protect, manage, c.adminList);
router.get('/admin/accounts/:id', protect, manage, c.adminGet);
router.post('/admin/accounts/:id/adjust', protect, manage, lim(30), c.adminAdjust);
router.post('/admin/accounts/:id/recalc', protect, manage, c.adminRecalc);
router.patch('/admin/accounts/:id/status', protect, manage, c.adminStatus);
router.get('/admin/program', protect, manage, c.adminProgram);
router.put('/admin/program', protect, manage, c.adminProgramSave);
router.get('/admin/rewards', protect, manage, c.adminRewards);
router.post('/admin/rewards', protect, manage, c.adminRewardSave);
router.put('/admin/rewards/:id', protect, manage, c.adminRewardSave);
router.get('/admin/integrations', protect, manage, c.adminIntegrations);

// Apple Wallet Passes Web Service — webServiceURL = {PUBLIC_API_URL}/api/loyalty/apple
const appleLim = lim(120);
router.post('/apple/v1/devices/:deviceId/registrations/:passTypeId/:serial', appleLim, c.appleRegister);
router.delete('/apple/v1/devices/:deviceId/registrations/:passTypeId/:serial', appleLim, c.appleUnregister);
router.get('/apple/v1/devices/:deviceId/registrations/:passTypeId', appleLim, c.appleSerials);
router.get('/apple/v1/passes/:passTypeId/:serial', appleLim, c.appleLatestPass);
router.post('/apple/v1/log', appleLim, c.appleLog);

module.exports = router;
