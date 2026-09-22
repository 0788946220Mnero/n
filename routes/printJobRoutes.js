const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  createJob,
  pendingJobs,
  claimJob,
  finishJob,
  getJob,
} = require('../controllers/printJobController');

/*
  الطباعة عن بُعد:
  - أي كاشير فما فوق يُرسل أمر طباعة من أي جهاز (حتى الجوال)
  - جهاز DiyarPOS يستلمه لحظياً عبر WebSocket، يحجزه ذرّياً، ينفّذه، ويبلغ النتيجة
*/
router.post('/', protect, authorize('admin', 'manager', 'cashier'), createJob);
router.get('/pending', protect, pendingJobs);
router.post('/:id/claim', protect, claimJob);
router.patch('/:id', protect, finishJob);
router.get('/:id', protect, getJob);

module.exports = router;
