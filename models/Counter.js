const mongoose = require('mongoose');

/*
  عدّاد ذرّي (Atomic) لتوليد أرقام تسلسلية لا تتكرر أبداً.
  نستخدم findOneAndUpdate مع $inc — وهي عملية ذرّية في MongoDB،
  فحتى لو وصل طلبان في نفس الجزء من الثانية يحصل كل واحد على رقم مختلف.
*/
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // مثال: 'order'
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);
