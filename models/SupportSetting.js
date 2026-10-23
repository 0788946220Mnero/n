const mongoose = require('mongoose');

/* إعدادات «تواصل مع فريق العمل»: الأسئلة السريعة، الردود الجاهزة، الرد التلقائي، مدة الاحتفاظ. */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'settings', unique: true },
    quickQuestions: {
      type: [String],
      default: ['أين طلبي؟', 'هل التوصيل متاح لمنطقتي؟', 'ما هي عروض اليوم؟', 'ما هي مواعيد العمل؟', 'أريد تقديم ملاحظة أو شكوى'],
    },
    cannedReplies: {
      type: [{ title: { type: String, maxlength: 40 }, text: { type: String, maxlength: 1000 }, _id: false }],
      default: [
        { title: 'ترحيب', text: 'أهلاً وسهلاً بك في ديار الأنباط 🌿 كيف نقدر نساعدك؟' },
        { title: 'الطلب قيد التحضير', text: 'طلبك قيد التحضير الآن، وسيصلك بأسرع وقت إن شاء الله.' },
        { title: 'التوصيل متاح', text: 'نعم، التوصيل متاح لمنطقتك. تقدر تطلب مباشرة من زر «طلب مباشر».' },
        { title: 'شكراً', text: 'شكراً لتواصلك معنا، يسعدنا خدمتك دائماً 🙏' },
      ],
    },
    autoReplyEnabled: { type: Boolean, default: true },
    autoReplyText: {
      type: String,
      default: 'شكراً لتواصلك مع ديار الأنباط 🌙 نحن خارج ساعات العمل الآن، وسيرد عليك فريق العمل فور عودتنا.',
      maxlength: 500,
    },
    retentionDays: { type: Number, default: 0, min: 0, max: 3650 }, // 0 = بلا حذف تلقائي
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupportSetting', settingSchema);
