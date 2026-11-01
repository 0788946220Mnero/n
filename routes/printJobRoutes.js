const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  createJob,
  pendingJobs,
  claimJob,
  finishJob,
  getJob,
  stationPing,
  listStations,
} = require('../controllers/printJobController');

/*
  الطباعة عن بُعد:
  - أي كاشير فما فوق يُرسل أمر طباعة من أي جهاز (حتى الجوال)
  - جهاز DiyarPOS يستلمه لحظياً عبر WebSocket، يحجزه ذرّياً، ينفّذه، ويبلغ النتيجة
*/
// الطباعة: الكاشير فما فوق — ومن يملك «صرف للموظفين» يطبع سندات صرف الموظفين فقط (يُتحقق في المتحكّم)
const canPrint = (req, res, next) => {
  if (['admin', 'manager', 'cashier'].includes(req.user.role)) return next();
  const { hasPermission } = require('../middlewares/permission');
  if (req.body && req.body.type === 'expense' && hasPermission(req.user, 'employees:pay')) return next();
  // بيع سنتر من داخل المطعم (موظف): طباعة طلبه هو فقط — يُتحقق في المتحكّم
  if (req.body && req.body.type === 'confirm' && req.user.role !== 'center' && hasPermission(req.user, 'center:sell')) return next();
  return res.status(403).json({ success: false, message: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
};
router.post('/', protect, canPrint, createJob);
router.get('/pending', protect, pendingJobs);
// محطة الطباعة (جهاز كاشير داخل المطعم): نبضتها، ومن يرسل أمراً يرى إن كانت متصلة
router.post('/station', protect, authorize('admin', 'manager', 'cashier'), stationPing);
router.get('/stations', protect, listStations);
router.post('/:id/claim', protect, claimJob);
router.patch('/:id', protect, finishJob);
router.get('/:id', protect, getJob);

module.exports = router;
