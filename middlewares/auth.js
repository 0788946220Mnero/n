const jwt = require('jsonwebtoken');
const User = require('../models/User');

// التحقق من وجود توكن صالح
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'غير مصرح، الرجاء تسجيل الدخول' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'المستخدم غير موجود أو غير مفعل' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'التوكن غير صالح أو منتهي الصلاحية' });
  }
};

// التحقق من الصلاحية بناءً على الدور
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
    }
    next();
  };
};

module.exports = { protect, authorize };
