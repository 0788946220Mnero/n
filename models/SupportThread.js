const mongoose = require('mongoose');

/*
  «تواصل مع فريق العمل» — محادثة زبون واحدة لكل رقم هاتف (PhoneUser).
  منفصلة عن دردشة الطاقم (ChatConversation): الزبون ليس مستخدماً في لوحة التحكم،
  ويرد عليه كل من يملك صلاحية support:reply.
*/
const supportThreadSchema = new mongoose.Schema(
  {
    phoneUser: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneUser', required: true, unique: true, index: true },
    phone: { type: String, required: true, index: true },
    name: { type: String, default: '', trim: true, maxlength: 60 }, // يكتبه الزبون (اختياري)
    lastText: { type: String, default: '' },
    lastFrom: { type: String, enum: ['customer', 'staff', ''], default: '' },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    unreadStaff: { type: Number, default: 0 },    // رسائل الزبون التي لم يقرأها الطاقم
    unreadCustomer: { type: Number, default: 0 }, // ردود الطاقم التي لم يقرأها الزبون
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupportThread', supportThreadSchema);
