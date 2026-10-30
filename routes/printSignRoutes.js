const express = require('express');
const router = express.Router();
const { printOrAdmin } = require('../middlewares/printOrAdmin');
const { getCertificate, signMessage } = require('../controllers/printSignController');

// الشهادة عامة — تُقرأ من أي مكان (QZ Tray نفسه يطلبها)
router.get('/cert', getCertificate);

// التوقيع محمي بنفس حماية مسارات الطباعة (بطاقة الطباعة أو تسجيل دخول لوحة التحكم)
router.post('/sign', printOrAdmin, signMessage);

module.exports = router;
