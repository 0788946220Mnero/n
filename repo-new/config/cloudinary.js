// إعداد Cloudinary — يقرأ المتغيّرات من بيئة Railway:
//   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
// ملاحظة: نستخدم الإصدار v2 من واجهة cloudinary.
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // إجبار روابط https في كل مكان
});

module.exports = cloudinary;
