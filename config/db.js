const mongoose = require('mongoose');

// ينشئ مستخدم أدمن افتراضياً عند أول إقلاع إن لم يوجد أي أدمن.
// يمكن تخصيص البيانات عبر متغيّرات البيئة: ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_NAME
const ensureAdminUser = async () => {
  try {
    const User = require('../models/User');
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    const adminPhone = (process.env.ADMIN_PHONE || '').trim();
    const exists = await User.findOne({ username });
    if (exists) {
      // ✅ إن ضُبط ADMIN_PHONE ولم يكن للحساب رقم، نضبطه تلقائياً
      // (بدونه لا تعمل استعادة كلمة المرور لأن المطابقة تتم بالرقم)
      if (adminPhone && !exists.phone) {
        exists.phone = adminPhone;
        await exists.save();
        console.log(`📱 تم ضبط رقم هاتف حساب ${username} لاستعادة كلمة المرور: ${adminPhone}`);
      }
      if (!exists.phone) {
        console.warn(`⚠️ الحساب ${username} بلا رقم هاتف — استعادة كلمة المرور لن تعمل. اضبط ADMIN_PHONE أو أضف الرقم من لوحة التحكم.`);
      }
      return;
    }
    await User.create({
      name: process.env.ADMIN_NAME || 'مدير النظام',
      username,
      password: process.env.ADMIN_PASSWORD || 'Admin@123',
      phone: adminPhone,
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
