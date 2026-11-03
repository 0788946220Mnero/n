const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    address: { type: String, default: '' },
    notes: { type: String, default: '' },
    ordersCount: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    firstOrderAt: { type: Date, default: null },
    lastOrderAt: { type: Date, default: null },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, default: '' },
    // آخر عنوان وموقع للزبون (من المنصة أو السنتر) — يُعبّأ تلقائياً في الطلب القادم
    lastOrderType: { type: String, default: '' },
    lastAddressOption: { type: String, default: '' },
    lastAddressDetail: { type: String, default: '' },
    lastLatitude: { type: Number, default: null },
    lastLongitude: { type: Number, default: null },
    lastSource: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Customer', customerSchema);
