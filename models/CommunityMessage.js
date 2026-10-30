const mongoose = require('mongoose');

/*
  «الدردشة العامة» في منصة الزبائن: غرفة واحدة لكل الزبائن المسجّلين برقم الهاتف وفريق العمل.
  الحذف «ناعم»: تختفي الرسالة عن الزبائن وتبقى للطاقم مع سبب الحذف ومن حذفها.
*/
const messageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['customer', 'staff'], required: true },
    phoneUser: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneUser', default: null, index: true },
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerProfile', default: null, index: true },
    staffUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    staffName: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 500 },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityMessage', default: null },
    reports: [{ phoneUser: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneUser' }, at: Date, _id: false }],
    reportCount: { type: Number, default: 0, index: true },
    deleted: { type: Boolean, default: false, index: true },
    deletedByOwner: { type: Boolean, default: false },
    deletedByName: { type: String, default: '' },
    deletedReason: { type: String, default: '' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
messageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CommunityMessage', messageSchema);
