const jwt = require('jsonwebtoken');
const PhoneUser = require('../models/PhoneUser');
const otpProvider = require('../services/otpProvider');

/*
  مصادقة زبائن الموقع برقم الهاتف فقط (بدون بريد/كلمة مرور).
  التوكن يحمل type:'customer' لتمييزه عن توكنات الأدمن — لذلك
  لا يتعارض مع نظام لوحة التحكم إطلاقاً.
*/

const CUSTOMER_JWT_SECRET = () => process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;

const generateCustomerToken = (id) =>
  jwt.sign({ id, type: 'customer' }, CUSTOMER_JWT_SECRET(), {
    expiresIn: process.env.CUSTOMER_JWT_EXPIRES_IN || '90d',
  });

// تطبيع رقم الهاتف: إزالة الفراغات، تحويل 07xxxxxxxx الأردني إلى صيغة دولية +9627xxxxxxxx
const normalizePhone = (raw) => {
  if (!raw) return '';
  let p = String(raw).replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^07\d{8}$/.test(p)) p = '+962' + p.slice(1); // رقم أردني محلي
  if (/^7\d{8}$/.test(p)) p = '+962' + p;
  if (/^9627\d{8}$/.test(p)) p = '+' + p;
  return p;
};

const canSend = (phone) => {
  const now = Date.now();
  const list = (sendLog.get(phone) || []).filter((t) => now - t < 30 * 1000); // 30 ثانية
  sendLog.set(phone, list);

  if (list.length >= 20) return false; // يسمح حتى 20 محاولة خلال 30 ثانية

  list.push(now);
  return true;
};


// POST /api/auth/send-otp
const sendOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, message: 'رقم الهاتف غير صالح، مثال: 0791234567' });
    }
    if (!canSend(phone)) {
      return res.status(429).json({ success: false, message: 'محاولات كثيرة، انتظر 10 دقائق ثم أعد المحاولة' });
    }

    const result = await otpProvider.sendCode(phone);
    if (!result.success) {
      return res.status(500).json({ success: false, message: result.message || 'تعذر إرسال الرمز' });
    }

    res.json({
      success: true,
      message: 'تم إرسال رمز التحقق',
      phone, // الصيغة المطبَّعة — الواجهة تعيدها في خطوة التحقق
      clientSide: !!result.clientSide, // true مع Firebase (التحقق من المتصفح)
    });
  } catch (err) {
    console.error('sendOtp error:', err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء إرسال الرمز' });
  }
};

// POST /api/auth/verify-otp
const verifyOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();

    if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'رقم الهاتف غير صالح' });
    if (!code) return res.status(400).json({ success: false, message: 'الرجاء إدخال رمز التحقق' });

    const result = await otpProvider.verifyCode(phone, code);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message || 'الرمز غير صحيح' });
    }

    // إنشاء الحساب تلقائياً إن لم يوجد، أو تسجيل دخول مباشر إن وُجد
    let user = await PhoneUser.findOne({ phone });
    let isNewUser = false;
    if (!user) {
      user = await PhoneUser.create({ phone, isPhoneVerified: true, lastLogin: new Date() });
      isNewUser = true;
    } else {
      user.isPhoneVerified = true;
      user.lastLogin = new Date();
      await user.save();
    }

    const token = generateCustomerToken(user._id);

    res.json({
      success: true,
      isNewUser,
      token,
      user: {
        id: user._id,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
    });
  } catch (err) {
    console.error('verifyOtp error:', err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء التحقق' });
  }
};

// GET /api/auth/me — (نسخة الزبون؛ توكنات الأدمن تمرّ للراوتر القديم عبر middleware)
const getMe = async (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.phoneUser._id,
      phone: req.phoneUser.phone,
      isPhoneVerified: req.phoneUser.isPhoneVerified,
      createdAt: req.phoneUser.createdAt,
      lastLogin: req.phoneUser.lastLogin,
    },
  });
};

// POST /api/auth/logout — (نسخة الزبون؛ JWT عديم الحالة، الحذف يتم من الواجهة)
const logout = async (req, res) => {
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
};

module.exports = { sendOtp, verifyOtp, getMe, logout, normalizePhone };
