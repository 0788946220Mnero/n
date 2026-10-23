const mongoose = require('mongoose');

/* رسالة في محادثة «تواصل مع فريق العمل»: من الزبون أو من أحد الطاقم. */
const supportMessageSchema = new mongoose.Schema(
  {
    thread: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportThread', required: true, index: true },
    from: { type: String, enum: ['customer', 'staff'], required: true },
    staffUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    staffName: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
