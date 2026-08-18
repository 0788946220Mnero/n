const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    message: { type: String, required: true },
    sentToAll: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notification', notificationSchema);
