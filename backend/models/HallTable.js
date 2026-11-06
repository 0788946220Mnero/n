const mongoose = require('mongoose');

/** طاولة في الصالة: اسمها وقسمها (داخلي/خارجي/عائلات…) وحسابها المفتوح إن وُجد. */
const hallTableSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    zone: { type: String, default: '', trim: true, maxlength: 40 },
    seats: { type: Number, default: 4, min: 1, max: 60 },
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    // الحساب المفتوح الآن (null = الطاولة فارغة). يُحجز ذرّياً عند أول طلب.
    tab: { type: mongoose.Schema.Types.ObjectId, ref: 'HallTab', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.HallTable || mongoose.model('HallTable', hallTableSchema);
