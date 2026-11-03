const mongoose = require('mongoose');
const { Schema } = mongoose;

/** تقييم متجر لسائق بعد توصيلة مكتملة — توصيلة واحدة = تقييم واحد. */
const ratingSchema = new Schema(
  {
    store: { type: Schema.Types.ObjectId, ref: 'BrqStore', required: true, index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'BrqDriver', required: true, index: true },
    trip: { type: Schema.Types.ObjectId, ref: 'BrqTrip', required: true, unique: true },
    stars: { type: Number, required: true, min: 1, max: 5 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrqRating', ratingSchema, 'brq_ratings');
