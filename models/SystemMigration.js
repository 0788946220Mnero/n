const mongoose = require('mongoose');

/** علامات ترحيل البيانات لمرة واحدة: وجود المفتاح يعني أنه نُفّذ ولا يُعاد. */
const systemMigrationSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    doneAt: { type: Date, default: Date.now },
    changed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemMigration', systemMigrationSchema);
