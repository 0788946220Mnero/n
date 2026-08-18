const notFound = (req, res, next) => {
  res.status(404).json({ message: `المسار غير موجود: ${req.originalUrl}` });
};

const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  // أخطاء Multer الخاصة برفع الملفات — رسائل عربية واضحة بدل الرسالة الإنجليزية الافتراضية
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'حجم الملف كبير جداً، الرجاء رفع ملف أصغر' });
  }

  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    message: err.message || 'حدث خطأ في الخادم',
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
};

module.exports = { notFound, errorHandler };
