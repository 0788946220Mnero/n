const express = require('express');
const router = express.Router();
const { login, refresh, logout, getMe, requestCredentialChange, confirmCredentialChange, changePassword, forgotPassword, resetPassword } = require('../controllers/authController');
const { protect, authorize } = require('../middlewares/auth');

router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', protect, getMe);
router.post('/change-password', protect, changePassword);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/request-credential-change', protect, authorize('admin'), requestCredentialChange);
router.post('/confirm-credential-change', protect, authorize('admin'), confirmCredentialChange);

module.exports = router;
