const mongoose = require('mongoose');

/** وثيقة إعدادات واحدة (key = main). */
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    meterFlagFils: Number,
    perKmFils: Number,
    companyCutPerKmFils: Number,
    deliveryRadiusM: Number,
    areaRadiusKm: Number,
    offerTimeoutSec: Number,
    waveSize: Number,
    searchRadiusKm: Number,
    minStoreRatingForDriver: Number,
    maxConcurrentTrips: Number,
    // متجر المطعم في البراق: طلبات «حالة الطلبات» في المطعم تُرسل باسمه
    restaurantStore: { type: mongoose.Schema.Types.ObjectId, ref: 'BrqStore', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqSettings', settingsSchema, 'brq_settings');
