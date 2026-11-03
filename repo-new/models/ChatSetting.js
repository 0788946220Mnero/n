const mongoose = require('mongoose');

/** إعدادات «دردشة الطاقم» — يغيّرها مدير النظام. */
const chatSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'settings', unique: true },
    callsEnabled: { type: Boolean, default: true },
    videoEnabled: { type: Boolean, default: true },
    voiceEnabled: { type: Boolean, default: true },
    imagesEnabled: { type: Boolean, default: true },
    maxVoiceSec: { type: Number, default: 300, min: 10, max: 900 },
    retentionDays: { type: Number, default: 0, min: 0, max: 3650 }, // 0 = الوسائط تبقى دائماً
    personalPermsMigrated: { type: Boolean, default: false }, // ترحيل صلاحيات الدردشة لمرة واحدة (انظر chatService)
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatSetting', chatSettingSchema);
