const Device = require('../models/Device');

// POST /api/devices/register  { deviceId, fcmToken, platform }
// تسجيل جهاز الإدارة لاستقبال الإشعارات — بلا تكرار لنفس الجهاز.
const registerDevice = async (req, res) => {
  try {
    const { deviceId, fcmToken, platform } = req.body;
    if (!deviceId || !fcmToken) {
      return res.status(400).json({ success: false, message: 'deviceId و fcmToken مطلوبان' });
    }

    const allowed = ['android', 'ios', 'web'];
    const finalPlatform = allowed.includes(platform) ? platform : 'unknown';

    // نفس الجهاز لنفس المستخدم → تحديث لا إنشاء (يمنع التكرار)
    const device = await Device.findOneAndUpdate(
      { user: req.user._id, deviceId },
      {
        user: req.user._id,
        deviceId,
        fcmToken,
        platform: finalPlatform,
        lastSeen: new Date(),
        isActive: true,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // الرمز نفسه قد يكون مسجّلاً لمستخدم آخر على نفس الجهاز (تبديل حساب)
    await Device.updateMany(
      { fcmToken, _id: { $ne: device._id } },
      { $set: { isActive: false } }
    );

    res.json({ success: true, deviceId: device.deviceId });
  } catch (err) {
    console.error('registerDevice error:', err);
    res.status(500).json({ success: false, message: 'تعذّر تسجيل الجهاز' });
  }
};

// DELETE /api/devices/:deviceId — إلغاء التسجيل عند تسجيل الخروج
const unregisterDevice = async (req, res) => {
  try {
    await Device.findOneAndUpdate(
      { user: req.user._id, deviceId: req.params.deviceId },
      { $set: { isActive: false } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('unregisterDevice error:', err);
    res.status(500).json({ success: false, message: 'تعذّر إلغاء تسجيل الجهاز' });
  }
};

// GET /api/devices/my — أجهزة المستخدم الحالي (لشاشة "الأجهزة المسجّلة")
const myDevices = async (req, res) => {
  try {
    const devices = await Device.find({ user: req.user._id, isActive: true })
      .select('deviceId platform lastSeen createdAt')
      .sort('-lastSeen');
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذّر جلب الأجهزة' });
  }
};

module.exports = { registerDevice, unregisterDevice, myDevices };
