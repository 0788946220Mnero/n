const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 6, select: false },
    // رقم هاتف المدير (اختياري) — يُستخدم لاستعادة كلمة المرور عبر واتساب
    phone: { type: String, default: '', trim: true },
    role: {
      type: String,
      enum: ['admin', 'manager', 'cashier', 'employee'],
      default: 'employee',
    },
    permissions: [{ type: String }], // مثال: ['products:edit', 'orders:view']
    isActive: { type: Boolean, default: true },
    refreshToken: { type: String, select: false },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
