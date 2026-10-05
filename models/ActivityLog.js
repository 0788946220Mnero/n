const mongoose = require('mongoose');

/**
 * سجل نشاط مستخدمي لوحة التحكم (User Activity Log).
 * سجل إلحاقي فقط: لا يُعدَّل ولا يُحذف من الواجهة. يُكتب بلا انتظار (لا يبطئ العملية الأصلية).
 * لا يحوي كلمات مرور ولا رموز دخول ولا بيانات دفع.
 */
const activityLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    userName: { type: String, default: '' },
    role: { type: String, default: '' },
    // login | logout | order.create | order.confirm | order.status | order.cancel | order.complete |
    // order.assign_driver | order.delivery_sent | pos.sale | shift.open | shift.close |
    // expense.create | user.create | user.update | user.delete | settings.update |
    // product.create | product.update | product.delete | phone.block | phone.unblock
    action: { type: String, required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    orderNumber: { type: String, default: '' },
    amount: { type: Number, default: null },
    statusBefore: { type: String, default: '' },
    statusAfter: { type: String, default: '' },
    // تفاصيل ضرورية فقط (اسم المندوب، سبب الإلغاء، رقم الجرد...)
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

activityLogSchema.index({ user: 1, createdAt: -1 });
activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
