const mongoose = require('mongoose');

/**
 * إعدادات محرك الربحية (وثيقة واحدة key=main).
 *   dayStartHour: بداية يوم العمل بتوقيت عمّان — الساعة 6 تعني أن 02:00 فجراً تتبع اليوم السابق،
 *                 فالدوام الممتد بعد منتصف الليل يبقى يوماً مالياً واحداً.
 *   startedAt: بداية ترحيل التكلفة — المبيعات قبله لا تُكلَّف (لا نحسب الماضي بأسعار اليوم).
 */
const profitConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    dayStartHour: { type: Number, default: 6, min: 0, max: 12 },
    workDaysPerMonth: { type: Number, default: 26, min: 1, max: 31 },
    defaultShiftHours: { type: Number, default: 8, min: 1, max: 16 },
    overtimeMultiplier: { type: Number, default: 1.25, min: 1, max: 3 },
    includeDeliveryFeeInRevenue: { type: Boolean, default: false }, // رسوم التوصيل أمانة للمندوبين افتراضياً
    // فئات المصروفات التي هي شراء بضاعة (تُستبعد من التشغيلي لأن الاستهلاك يُحسب من المخزون)
    inventoryExpenseCategories: { type: [String], default: [] },
    lowMarginPct: { type: Number, default: 35 },      // هامش ربح إجمالي أقل منه = تنبيه
    targetFoodCostPct: { type: Number, default: 32 },
    wasteAlertPct: { type: Number, default: 4 },       // هدر/تكلفة المبيعات
    priceRiseAlertPct: { type: Number, default: 10 },
    rev: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ProfitConfig || mongoose.model('ProfitConfig', profitConfigSchema);
