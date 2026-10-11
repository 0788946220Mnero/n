const express = require('express');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/imageCloudController');

const router = express.Router();
const admin = requirePermission('images:cloud'); // مدير النظام افتراضياً، ويُمنح لغيره

router.get('/', protect, admin, c.get);
router.put('/', protect, admin, c.update);
router.post('/test', protect, admin, c.test);
router.get('/migrate', protect, admin, c.migrateStatus);
router.post('/migrate', protect, admin, c.migrateStart);
router.post('/nodes/join', protect, admin, c.nodeJoin);          // انضمام جهاز للمزامنة (مدير النظام)
router.post('/nodes/heartbeat', protect, c.nodeHeartbeat);       // نبض جهاز منضم (أي مستخدم على الجهاز)
router.post('/nodes/request', protect, c.nodeRequest);            // DiyarPOS يطلب الربط (أي حساب)
router.post('/nodes/claim', protect, c.nodeClaim);                // الجهاز المُوافَق عليه يستلم (يثبت هويته بسرّه)
router.post('/nodes/:nodeId/decide', protect, admin, c.nodeDecide); // موافقة/رفض المدير
router.delete('/nodes/:nodeId', protect, admin, c.nodeRemove);

module.exports = router;
