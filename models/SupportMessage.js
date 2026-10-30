const mongoose = require('mongoose');

/*
  رسالة في محادثة «تواصل مع فريق العمل».
  from: customer (الزبون) | staff (رد الطاقم) | system (رد تلقائي) | note (ملاحظة داخلية — للطاقم فقط، لا تصل الزبون أبداً)
  kind: text | image (CustomerMedia) | order (طلب أرفقه الزبون — نسخة من بياناته وقت الإرفاق)
*/
const supportMessageSchema = new mongoose.Schema(
  {
    thread: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportThread', required: true, index: true },
    from: { type: String, enum: ['customer', 'staff', 'system', 'note'], required: true },
    kind: { type: String, enum: ['text', 'image', 'order'], default: 'text' },
    staffUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    staffName: { type: String, default: '' },
    text: { type: String, default: '', maxlength: 1000 },
    media: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerMedia', default: null },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    order: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      orderNumber: { type: String, default: '' },
      status: { type: String, default: '' },
      total: { type: Number, default: 0 },
      orderType: { type: String, default: '' },
      createdAt: { type: Date, default: null },
    },
    responseMs: { type: Number, default: 0 }, // للرد الأول بعد انتظار الزبون: كم انتظر
    deleted: { type: Boolean, default: false },
    deletedByName: { type: String, default: '' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
