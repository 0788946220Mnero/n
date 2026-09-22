const mongoose = require('mongoose');

/*
  جهاز زبون مشترك في إشعارات المطعم.

  منفصل عن Device (أجهزة الإدارة) لأن ذاك يتطلّب حساب مستخدم،
  بينما الزبون قد يكون مجهولاً تماماً — يكفي توكن المتصفح.
*/
const pushSubscriberSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], default: 'web' },

    // هل ثُبِّت الموقع على الشاشة الرئيسية؟ (شرط وصول الإشعارات على الآيفون)
    standalone: { type: Boolean, default: false },

    phone: { type: String, default: '', index: true }, // إن كان الزبون مسجّلاً
    userAgent: { type: String, default: '' },
    lastSeen: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscriber', pushSubscriberSchema);
