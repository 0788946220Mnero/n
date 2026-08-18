const mongoose = require('mongoose');

// ينشئ مستخدم أدمن افتراضياً عند أول إقلاع إن لم يوجد أي أدمن.
// يمكن تخصيص البيانات عبر متغيّرات البيئة: ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_NAME
const ensureAdminUser = async () => {
  try {
    const User = require('../models/User');
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    const exists = await User.findOne({ username });
    if (exists) return;
    await User.create({
      name: process.env.ADMIN_NAME || 'مدير النظام',
      username,
      password: process.env.ADMIN_PASSWORD || 'Admin@123',
      role: 'admin',
    });
    console.log(`👤 تم إنشاء مستخدم الأدمن تلقائياً: ${username} / (كلمة المرور الافتراضية أو من ADMIN_PASSWORD)`);
  } catch (e) {
    console.error('⚠️ تعذّر إنشاء مستخدم الأدمن التلقائي:', e.message);
  }
};

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ تم الاتصال بقاعدة البيانات: ${conn.connection.host}`);
    await ensureAdminUser();
  } catch (error) {
    console.error(`❌ فشل الاتصال بقاعدة البيانات: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
