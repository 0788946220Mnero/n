const mongoose = require('mongoose');

/**
 * عدّاد أرقام سندات الصرف — في مجموعة مستقلة عمداً.
 *
 * مجموعة `counters` المشتركة في القاعدة الحية تحمل فهرساً فريداً قديماً
 * على حقل `key` غير معرّف في الكود؛ أي وثيقة جديدة فيها بلا `key` تتصادم
 * معه («key مستخدم بالفعل»). فلا نكتب فيها، ولا نحذف فهرسها لأن ترقيم
 * الطلبات يعتمد عليها.
 */
const expenseSequenceSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('ExpenseSequence', expenseSequenceSchema, 'expense_sequences');
