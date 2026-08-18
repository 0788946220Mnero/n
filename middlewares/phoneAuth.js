const jwt = require('jsonwebtoken');
const PhoneUser = require('../models/PhoneUser');

const CUSTOMER_JWT_SECRET = () => process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;

/*
  حماية مسارات الزبون (توكن type:'customer').
  إذا كان التوكن ليس توكن زبون (مثلاً توكن أدمن للوحة التحكم) نستدعي next('router')
  ليتخطى Express هذا الراوتر بالكامل ويمرر الطلب لراوتر الأدمن القديم على نفس المسار
  — بهذا يعمل /api/auth/me و /api/auth/logout للطرفين بدون أي كسر.
*/
const protectCustomer = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next('router'); // لا توكن — مرّر لراوتر الأدمن ليتعامل مع الرفض كما كان دائماً
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, CUSTOMER_JWT_SECRET());
  } catch (err) {
    return next('router'); // توكن غير صالح بمفتاح الزبون — قد يكون توكن أدمن
  }

  if (decoded.type !== 'customer') return next('router'); // توكن أدمن — تخطَّ هذا الراوتر

  const user = await PhoneUser.findById(decoded.id);
  if (!user) {
    return res.status(401).json({ success: false, message: 'الحساب غير موجود، الرجاء تسجيل الدخول مجدداً' });
  }

  req.phoneUser = user;
  next();
};

module.exports = { protectCustomer };
