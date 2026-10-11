const mongoose = require('mongoose');

/**
 * برنامج الولاء — وثيقة واحدة (key: 'main'). كل القيم قابلة للتعديل من لوحة التحكم؛
 * القيم الافتراضية هنا تجريبية فقط، والكود لا يفترض أي رقم ثابتاً.
 *
 * قواعد الاحتساب (موثّقة في docs/LOYALTY.md):
 *   النقاط = floor( (قيمة الأصناف − الخصم) × earnPerJod )   — بلا رسوم التوصيل، والتقريب للأسفل دائماً
 *   قيمة الاستبدال = النقاط ÷ redeemPointsPerJod دينار  (لمكافأة «خصم بالنقاط» العامة)
 */
const loyaltyProgramSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: true },
    programName: { type: String, default: 'نقاط ديار الأنباط', maxlength: 60 },
    earnPerJod: { type: Number, default: 10, min: 0, max: 1000 },          // نقاط لكل دينار
    redeemPointsPerJod: { type: Number, default: 1000, min: 1, max: 1000000 }, // كم نقطة = دينار
    minOrderToEarn: { type: Number, default: 0, min: 0 },                  // أقل قيمة طلب تكسب نقاطاً
    earnOnDeliveryFee: { type: Boolean, default: false },
    // مصادر الطلبات التي تكسب نقاطاً (pos: لحظة البيع، والباقي عند «تم التسليم»)
    earnSources: { type: [String], default: ['pos', 'web', 'app', 'center'] },
    terms: { type: String, default: 'تُكسب النقاط على الطلبات المدفوعة فقط، ولا تُستبدل نقداً.', maxlength: 1000 },
    // مظهر البطاقة (الصفحة وApple/Google)
    colors: {
      background: { type: String, default: '#1f1a17' },
      foreground: { type: String, default: '#ffffff' },
      label: { type: String, default: '#d4a017' },
    },
    logoUrl: { type: String, default: '' },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LoyaltyProgram', loyaltyProgramSchema);
