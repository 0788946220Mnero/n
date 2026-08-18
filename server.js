require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

// اتصال قاعدة البيانات
connectDB();

const app = express();
app.set('trust proxy', 2)

// ------- الأمان -------
app.use(helmet());
app.use(mongoSanitize()); // حماية ضد NoSQL Injection
app.use(xss()); // حماية ضد XSS

// إعداد CORS متسامح: يقبل النطاق المحدّد في CLIENT_URL (مع تجاهل الشرطة/المسافات الزائدة)
// وأي نطاق فرعي على netlify.app و localhost للتطوير.
const allowedOrigins = (process.env.CLIENT_URL || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // السماح للطلبات بلا Origin (مثل أدوات الخادم أو نفس النطاق)
    if (!origin) return callback(null, true);
    const clean = origin.replace(/\/+$/, '');
    if (
      allowedOrigins.includes(clean) ||
      /\.netlify\.app$/.test(clean) ||
      /^https?:\/\/localhost(:\d+)?$/.test(clean)
    ) {
      return callback(null, true);
    }
    return callback(null, true); // مؤقتاً: نسمح للجميع لضمان عمل الموقع (يمكن تشديده لاحقاً)
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // الرد على طلبات preflight

// تحديد عدد الطلبات لمنع إساءة الاستخدام (Rate Limiting)
// const limiter = rateLimit({
 // windowMs: 15 * 60 * 1000, // 15 دقيقة
 // max: 300,
 // message: { message: 'عدد كبير من الطلبات، الرجاء المحاولة لاحقاً' },
//});
// app.use('/api', limiter);

// ------- تحليل البيانات -------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ------- الصور والوسائط تُخزَّن الآن على Cloudinary (لا مجلد uploads محلي) -------

// ------- المسارات (Routes) -------
// مصادقة الزبائن بالهاتف (OTP) — تُركَّب قبل راوتر الأدمن؛ توكنات الأدمن تمرّ خلالها بأمان
app.use('/api/auth', require('./routes/phoneAuthRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/customers', require('./routes/customerRoutes'));
app.use('/api/settings', require('./routes/settingRoutes'));
app.use('/api/print', require('./routes/printSignRoutes')); // شهادة QZ Tray وتوقيع طلبات الطباعة
app.use('/api/users', require('./routes/userRoutes')); // إدارة مستخدمي الإدارة (تطبيق الإدارة)
app.use('/api/devices', require('./routes/deviceRoutes')); // تسجيل أجهزة الإشعارات (FCM)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'الخادم يعمل بنجاح' });
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
  console.log(`🔒 OTP Provider النشط: ${process.env.OTP_PROVIDER || 'dev'}`);
});
