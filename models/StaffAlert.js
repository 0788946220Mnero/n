const mongoose = require('mongoose');

/**
 * «إشعارات الطاقم»: الإعدادات (key=settings) وسجل ما أُرسل (key=log) في مجموعة واحدة.
 *   settings.events: { [نوع الحدث]: { enabled, roles: [], users: [], minAmount } }
 *   سجل كل إرسال: يدوي من مدير النظام أو تلقائي من حدث (بيع، إلغاء، جرد، مصروف…).
 */
const staffAlertSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, index: true }, // 'settings' | 'log'
    // الإعدادات
    events: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // السجل
    kind: { type: String, default: '' }, // manual | event
    type: { type: String, default: '' },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    target: { type: mongoose.Schema.Types.Mixed, default: undefined },
    byName: { type: String, default: '' },
    users: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StaffAlert', staffAlertSchema);
