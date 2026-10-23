const express = require('express');
const router = express.Router();
const { sendOtp, verifyOtp, getMe, logout } = require('../controllers/phoneAuthController');
const { protectCustomer } = require('../middlewares/phoneAuth');
const pin = require('../controllers/pinAuthController');

/*
  يُركَّب هذا الراوتر على /api/auth *قبل* راوتر الأدمن القديم.
  - /send-otp و /verify-otp مسارات جديدة لا تتعارض مع شيء.
  - /me و /logout تُعالَج هنا فقط إذا كان التوكن توكن زبون (type:'customer')،
    وإلا فإن protectCustomer يستدعي next('router') فيمرّ الطلب
    لراوتر الأدمن القديم كما كان تماماً — صفر كسر للوحة التحكم.
*/
// الدخول المعتمد: رقم الهاتف + رمز PIN (بلا رسائل تحقق) — انظر controllers/pinAuthController.js
router.post('/pin/status', pin.status);
router.post('/pin/login', pin.login);
router.post('/pin/report', pin.report);
router.post('/pin/reclaim', pin.reclaim);

// رمز التحقق القديم: باقٍ ولم تعد الواجهة تستخدمه
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.get('/me', protectCustomer, getMe);
router.post('/logout', protectCustomer, logout);

module.exports = router;
