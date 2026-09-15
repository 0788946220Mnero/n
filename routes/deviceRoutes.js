const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { registerDevice, unregisterDevice, myDevices } = require('../controllers/deviceController');

// كل المسارات تتطلب تسجيل دخول إداري
router.post('/register', protect, registerDevice);
router.get('/my', protect, myDevices);
router.delete('/:deviceId', protect, unregisterDevice);

module.exports = router;
