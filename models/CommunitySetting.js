const mongoose = require('mongoose');

/* إعدادات «الدردشة العامة» والفلترة — يديرها من يملك community:moderate. */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'settings', unique: true },
    enabled: { type: Boolean, default: true },
    blockedWords: { type: [String], default: [] },
    blockLinks: { type: Boolean, default: true },
    blockPhones: { type: Boolean, default: true },
    slowModeSeconds: { type: Number, default: 5, min: 0, max: 600 },
    rules: {
      type: String,
      default: 'أهلاً بك في مجتمع ديار الأنباط 🌿 احترم الجميع، ولا روابط ولا أرقام هواتف ولا إعلانات. للطلبات والشكاوى الخاصة استخدم «تواصل مع فريق العمل».',
      maxlength: 600,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CommunitySetting', settingSchema);
