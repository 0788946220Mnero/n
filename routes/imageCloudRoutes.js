const express = require('express');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const c = require('../controllers/imageCloudController');
const relay = require('../services/imageRelayService');
const rateLimit = require('express-rate-limit');

/**
 * «خادم صور ديار» المستقل لا يملك حساب مستخدم: يثبت هويته بسرّه (nodeId + proof في الجسم)
 * والمتحكم يتحقق منه. مع رأس Authorization ← تحقق المستخدم المعتاد (DiyarPOS).
 */
const userOrDevice = (req, res, next) => {
  if (req.headers.authorization) return protect(req, res, next);
  const b = req.body || {};
  if (typeof b.nodeId === 'string' && typeof b.proof === 'string' && b.proof.length >= 16) { req.device = true; return next(); }
  return res.status(401).json({ message: 'غير مصرح، الرجاء تسجيل الدخول' });
};
// رمز الاقتران: محاولات قليلة لكل عنوان (الرمز 8 خانات، 30 دقيقة، مرة واحدة)
const pairLimiter = rateLimit({ windowMs: 15 * 60000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة — انتظر ربع ساعة ثم أعد المحاولة' } });

const router = express.Router();

// نفق الصور (عام): الموقع والزبائن يرون الصور فقط — /api/image-cloud/relay/media/{id}/{variant}
const relayRouter = express.Router();
relayRouter.get(/^\/media\//, relay.serveMedia); // HEAD يُعالَج بنفس الدالة
router.use('/relay', relayRouter);
const admin = requirePermission('images:cloud'); // مدير النظام افتراضياً، ويُمنح لغيره

router.get('/', protect, admin, c.get);
router.put('/', protect, admin, c.update);
router.post('/test', protect, admin, c.test);
router.post('/diagnose', protect, admin, c.diagnose);  // IMAGE-SERVER: تشخيص خطوة بخطوة
router.get('/migrate', protect, admin, c.migrateStatus);
router.post('/migrate', protect, admin, c.migrateStart);
router.post('/nodes/join', protect, admin, c.nodeJoin);          // انضمام جهاز للمزامنة (مدير النظام)
router.post('/nodes/heartbeat', userOrDevice, c.nodeHeartbeat);  // نبض جهاز منضم (أي مستخدم على الجهاز، أو الخادم المستقل بسرّه)
router.post('/pair-codes', protect, admin, c.pairCode);           // رمز اقتران «خادم صور ديار» المستقل
router.post('/nodes/pair', pairLimiter, c.nodePair);              // الخادم المستقل يقدّم الرمز (بلا حساب)
router.post('/nodes/request', protect, c.nodeRequest);            // DiyarPOS يطلب الربط (أي حساب)
router.post('/nodes/claim', userOrDevice, c.nodeClaim);           // الجهاز المُوافَق عليه يستلم (يثبت هويته بسرّه)
router.post('/nodes/key', userOrDevice, c.nodeKey);               // الجهاز يرسل مفتاحه حين يطلبه الخادم (بسرّه)
router.post('/nodes/:nodeId/decide', protect, admin, c.nodeDecide); // موافقة/رفض المدير
router.delete('/nodes/:nodeId', protect, admin, c.nodeRemove);
router.get('/relay-status', protect, admin, c.relayStatus);       // الأجهزة المتصلة بالنفق والتخزين المؤقت

module.exports = router;
