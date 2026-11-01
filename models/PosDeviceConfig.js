const mongoose = require('mongoose');

/**
 * رمز إعدادات أجهزة الكاشير (DiyarPOS) — وثيقة واحدة يعيّنها ويعيد تعيينها مدير النظام.
 * نحفظ PBKDF2-SHA256 (ملح عشوائي + تكرارات) لا الرمز نفسه، والتطبيق يتحقق محلياً فيعمل بلا إنترنت.
 * version يزيد مع كل تعيين فيعرف كل جهاز أن نسخته قديمة.
 */
const posDeviceConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    pinSalt: { type: String, default: '' },
    pinHash: { type: String, default: '' },
    pinIter: { type: Number, default: 0 },
    pinVersion: { type: Number, default: 0 },
    pinSetAt: { type: Date, default: null },
    pinSetByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PosDeviceConfig', posDeviceConfigSchema);
