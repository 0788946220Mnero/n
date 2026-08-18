const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// الشهادة الرقمية العامة (تُرسَل لـ QZ Tray عبر setCertificatePromise) — لا تحتوي أي سر
const CERT_PATH = path.join(__dirname, '..', 'certs', 'qz-digital-certificate.txt');

// GET /api/print/cert — عام، لا يحتاج تسجيل دخول (الشهادة عامة أصلاً)
const getCertificate = (req, res) => {
  try {
    const cert = fs.readFileSync(CERT_PATH, 'utf8');
    res.type('text/plain').send(cert);
  } catch (err) {
    res.status(500).json({ message: 'تعذر قراءة الشهادة الرقمية', error: err.message });
  }
};

// POST /api/print/sign — محمي (نفس حماية مسارات الطباعة الأخرى)
// يوقّع نص الطلب القادم من QZ Tray بالمفتاح الخاص (SHA512withRSA) دون كشفه أبداً للواجهة
// body: { request: '<النص المطلوب توقيعه من QZ Tray>' }
const signMessage = (req, res) => {
  try {
    const { request } = req.body;
    if (!request) {
      return res.status(400).json({ message: 'الطلب المراد توقيعه مفقود' });
    }
    const b64Key = process.env.PRINT_PRIVATE_KEY_BASE64;
    if (!b64Key) {
      return res.status(500).json({ message: 'مفتاح توقيع الطباعة غير مضبوط على الخادم (PRINT_PRIVATE_KEY_BASE64)' });
    }
    const privateKey = Buffer.from(b64Key, 'base64').toString('utf8');
    const signature = crypto.sign('RSA-SHA512', Buffer.from(request, 'utf8'), privateKey).toString('base64');
    res.json({ success: true, signature });
  } catch (err) {
    res.status(500).json({ message: 'تعذر توقيع طلب الطباعة', error: err.message });
  }
};

module.exports = { getCertificate, signMessage };
