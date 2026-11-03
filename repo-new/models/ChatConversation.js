const mongoose = require('mongoose');

/**
 * محادثة في «دردشة الطاقم»:
 *  direct ← بين شخصين (key = d:<id1>:<id2> مرتّبين — لا تتكرر)
 *  group  ← مجموعة ينشئها أي مستخدم؛ منشئها مشرفها (admins)
 *  key = 'all' ← «كل الطاقم»: كل من يملك صلاحية الدردشة عضو فيها تلقائياً (members لا تُستعمل)
 * reads: { userId: تاريخ آخر قراءة } — منها عدد غير المقروء وعلامتا القراءة.
 * لا تُحذف نهائياً: deleted يخفيها (مشرف المجموعة أو مدير النظام).
 */
const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    key: { type: String, default: undefined },
    name: { type: String, default: '', trim: true, maxlength: 60 },
    members: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [], index: true },
    admins: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
    muted: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    reads: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastMessage: { type: mongoose.Schema.Types.Mixed, default: null }, // { text, kind, senderName, sender, at }
    lastAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedByName: { type: String, default: '' },
  },
  { timestamps: true, minimize: false }
);
conversationSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });

module.exports = mongoose.model('ChatConversation', conversationSchema);
