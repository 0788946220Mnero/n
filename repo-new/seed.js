// سكربت لإنشاء أول مستخدم مدير نظام
// طريقة التشغيل: node seed.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const exists = await User.findOne({ username: 'admin' });
  if (exists) {
    await User.deleteOne({ username: "admin" });

  }

  await User.create({
    name: 'مدير النظام',
    username: 'admin',
    password: 'Admin@123', // غيّرها فوراً بعد أول تسجيل دخول
    role: 'admin',
  });

  console.log('✅ تم إنشاء المستخدم: admin / Admin@123');
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
