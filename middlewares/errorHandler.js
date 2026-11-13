const notFound = (req, res, next) => {
  res.status(404).json({ success: false, message: `المسار غير موجود: ${req.originalUrl}` });
};

const errorHandler = (err, req, res, next) => {
  console.error('❌', err && err.stack ? err.stack : err);

  const isProd = process.env.NODE_ENV === 'production';

  // 1) نطاق غير مسموح (CORS)
  if (err && /النطاق غير مسموح/.test(err.message || '')) {
    return res.status(403).json({ success: false, message: err.message });
  }

  // 2) رفع الملفات (Multer)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'حجم الملف كبير جداً، الرجاء رفع ملف أصغر' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ success: false, message: 'حقل الملف المُرسَل غير متوقَّع' });
  }

  // 3) معرّف غير صالح (كان يُسقط الخادم سابقاً عند طلب /api/products/abc)
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'المعرّف المُرسَل غير صالح' });
  }

  // 4) أخطاء التحقق من النموذج (Mongoose)
  if (err.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    return res.status(400).json({
      success: false,
      message: (first && first.message) || 'بيانات غير صالحة',
    });
  }

  // 5) تكرار قيمة فريدة
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'القيمة';
    return res.status(409).json({ success: false, message: `${field} مستخدم بالفعل` });
  }

  // 6) أخطاء التوكن
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'التوكن غير صالح' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة، الرجاء تسجيل الدخول مجدداً' });
  }

  // 7) أي خطأ آخر
  const statusCode = err.statusCode || (res.statusCode && res.statusCode !== 200 ? res.statusCode : 500);
  res.status(statusCode).json({
    success: false,
    // في الإنتاج لا نكشف تفاصيل الأخطاء الداخلية للعميل
    message: statusCode === 500 && isProd ? 'حدث خطأ في الخادم' : err.message || 'حدث خطأ في الخادم',
    stack: isProd ? undefined : err.stack,
  });
};

module.exports = { notFound, errorHandler };
