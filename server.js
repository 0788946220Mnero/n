require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');

const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

// اتصال قاعدة البيانات
connectDB();

const app = express();
app.set('trust proxy', 2); // Railway خلف بروكسي — ضروري لقراءة IP الحقيقي

// ------- الأمان -------
// ملاحظة: هذا خادم API فقط (لا يخدم صفحات HTML)، لذلك:
//  • نعطّل CSP لأنه لا معنى له هنا وقد يعيق ردود JSON/الشهادة
//  • نجعل Cross-Origin-Resource-Policy = cross-origin حتى تستطيع المواقع
//    على نطاقات أخرى (diyaralanbat.com و netlify) قراءة موارد الخادم
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(mongoSanitize()); // حماية ضد NoSQL Injection
app.use(xss()); // حماية ضد XSS

// ═══════════════════════ إعداد CORS ═══════════════════════
// النطاقات المسموحة = القائمة الثابتة أدناه + أي نطاق يُضاف في متغيّر البيئة
// CLIENT_URL (مفصولة بفواصل) + أي نطاق فرعي على netlify.app + localhost للتطوير.
//
// مهم: النطاق الأساسي والنسخة بـ www يُعدّان نطاقين مختلفين عند المتصفح،
// لذلك كلاهما مُدرج صراحةً.
const DEFAULT_ORIGINS = [
  'https://diyaralanbat.com',
  'https://www.diyaralanbat.com',
  'https://diyaralanbat.netlify.app',
  'https://diyaradmin.netlify.app',
];

const envOrigins = (process.env.CLIENT_URL || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const allowedOrigins = [...new Set([...DEFAULT_ORIGINS, ...envOrigins])];

const isAllowedOrigin = (origin) => {
  const clean = String(origin).replace(/\/+$/, '');
  return (
    allowedOrigins.includes(clean) ||
    /^https:\/\/([a-z0-9-]+\.)*netlify\.app$/i.test(clean) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(clean) ||
    /^capacitor:\/\//i.test(clean) // تطبيق الإدارة (WebView)
  );
};

const corsOptions = {
  origin(origin, callback) {
    // طلبات بلا Origin: أدوات الخادم، برنامج الطابعة المحلي، تطبيق Flutter — مسموحة
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    console.warn(`⛔ CORS: طلب مرفوض من النطاق ${origin}`);
    return callback(new Error(`النطاق غير مسموح: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-print-token'],
  maxAge: 86400, // تخزين نتيجة preflight يوماً كاملاً — أسرع للموقع
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // الرد على طلبات preflight

// ------- تحليل البيانات -------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ------- الصور والوسائط تُخزَّن على Cloudinary (لا مجلد uploads محلي) -------

// ------- المسارات (Routes) -------
// مصادقة الزبائن بالهاتف (OTP) — تُركَّب قبل راوتر الأدمن؛ توكنات الأدمن تمرّ خلالها بأمان
app.use('/api/auth', require('./routes/phoneAuthRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/customers', require('./routes/customerRoutes'));
app.use('/api/settings', require('./routes/settingRoutes'));
app.use('/api/printers', require('./routes/printerRoutes')); // إدارة الطابعات وتوجيه التصنيفات
app.use('/api/print', require('./routes/printSignRoutes')); // شهادة QZ Tray وتوقيع طلبات الطباعة
app.use('/api/users', require('./routes/userRoutes')); // إدارة مستخدمي الإدارة (تطبيق الإدارة)
app.use('/api/devices', require('./routes/deviceRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes')); // إشعارات الزبائن (عروض ومناسبات) // تسجيل أجهزة الإشعارات (FCM)

// فحص صحة الخادم — يفيد أيضاً لاختبار CORS من المتصفح
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'الخادم يعمل بنجاح',
    origin: req.headers.origin || null,
    allowedOrigins,
    time: new Date().toISOString(),
  });
});

// ------- معالجة الأخطاء -------
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const http = require('http');
const server = http.createServer(app);

// خدمة الوقت الحقيقي — تشارك نفس منفذ الخادم
const realtime = require('./services/realtimeService');
realtime.init(server);

server.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
  console.log(`🌐 النطاقات المسموحة: ${allowedOrigins.join(' | ')}`);
});

// ------- شبكة أمان: لا نسمح لخطأ غير متوقّع بإسقاط الخادم صامتاً -------
process.on('unhandledRejection', (err) => {
  console.error('❌ رفض غير معالَج:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ استثناء غير ملتقَط:', err && err.stack ? err.stack : err);
});

module.exports = app;
