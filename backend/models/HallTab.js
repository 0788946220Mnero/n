const mongoose = require('mongoose');

/**
 * حساب طاولة مفتوح: جولات من الأصناف تُرسل للمطبخ تباعاً، ثم يُغلق بالدفع عند الكاشير
 * فيصير طلباً واحداً (Order, source:'hall') يدخل جرد من قبض المال.
 * حتى الدفع لا يدخل أي جرد ولا إحصائيات.
 */
const tabItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  nameAr: String,
  price: Number, // سعر الوحدة مع الإضافات — من قاعدة البيانات لحظة الطلب
  quantity: { type: Number, default: 1 },
  addons: [{ _id: false, name: String, price: Number }],
  notes: { type: String, default: '' },
  printerName: { type: String, default: '' },
  round: { type: Number, default: 1 },
  addedByName: { type: String, default: '' },
  addedAt: { type: Date, default: Date.now },
  voided: { type: Boolean, default: false },
  voidedByName: { type: String, default: '' },
  voidReason: { type: String, default: '' },
});

const hallTabSchema = new mongoose.Schema(
  {
    table: { type: mongoose.Schema.Types.ObjectId, ref: 'HallTable', required: true, index: true },
    tableName: { type: String, default: '' },
    zone: { type: String, default: '' },
    guests: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'paid', 'void'], default: 'open', index: true },
    items: { type: [tabItemSchema], default: [] },
    rounds: { type: Number, default: 0 },
    notes: { type: String, default: '', maxlength: 300 },
    waiter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    waiterName: { type: String, default: '' },
    billRequestedAt: { type: Date, default: null },
    // إعادة الإرسال من جوال انقطعت شبكته لا تُضيف الجولة مرتين
    clientRefs: { type: [String], default: [] },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    closedAt: { type: Date, default: null },
    closedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.HallTab || mongoose.model('HallTab', hallTabSchema);
