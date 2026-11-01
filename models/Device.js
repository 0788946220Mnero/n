const mongoose = require('mongoose');

/**
 * أجهزة الإدارة المسجَّلة لاستقبال إشعارات FCM.
 * الفهرس المركّب يمنع تكرار نفس الجهاز لنفس المستخدم.
 */
const deviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceId: { type: String, required: true },        // معرّف الجهاز من التطبيق
    fcmToken: { type: String, required: true, index: true },
    platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], default: 'unknown' },
    lastSeen: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// جهاز واحد لكل مستخدم — لا تكرار
deviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('Device', deviceSchema);
