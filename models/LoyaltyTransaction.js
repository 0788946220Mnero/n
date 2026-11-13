const mongoose = require('mongoose');

/**
 * سجل نقاط الولاء — المرجع الأساسي للرصيد (لا يُعدَّل ولا يُحذف؛ التصحيح بمعاملة عكسية).
 *
 * idemKey فريد: يمنع تكرار العملية نفسها مهما أُعيد إرسال الطلب أو انقطع الاتصال:
 *   earn:<orderId>            منح نقاط فاتورة (مرة واحدة)
 *   redeem:<clientRef|id>     استبدال عند البيع (مرة واحدة لكل عملية بيع)
 *   reverse_earn:<orderId>    سحب نقاط فاتورة أُلغيت بعد منحها
 *   reverse_redeem:<orderId>  إرجاع نقاط استُبدلت على فاتورة أُلغيت
 *   adjust:<uuid>             تعديل يدوي (المستخدم والسبب إلزاميان)
 */
const loyaltyTransactionSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyAccount', required: true },
    type: { type: String, enum: ['earn', 'redeem', 'reverse_earn', 'reverse_redeem', 'adjust'], required: true },
    points: { type: Number, required: true },        // موجب يضيف، سالب يخصم
    balanceAfter: { type: Number, required: true },
    idemKey: { type: String, required: true, unique: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    orderNumber: { type: String, default: '' },
    amount: { type: Number, default: 0 },            // قيمة الفاتورة المحتسبة (د.أ) أو قيمة الخصم
    reward: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyReward', default: null },
    rewardName: { type: String, default: '' },
    reason: { type: String, default: '', maxlength: 300 },
    byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    source: { type: String, default: '' },           // pos | web | center | admin | system
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

loyaltyTransactionSchema.index({ account: 1, createdAt: -1 });
loyaltyTransactionSchema.index({ order: 1 });
loyaltyTransactionSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('LoyaltyTransaction', loyaltyTransactionSchema);
