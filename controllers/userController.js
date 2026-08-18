const User = require('../models/User');

// الحقول الآمنة للإرجاع (كلمة المرور مستثناة أصلاً عبر select:false)
const SAFE_FIELDS = 'name username phone role isActive createdAt updatedAt';

// GET /api/users — قائمة مستخدمي الإدارة
const getUsers = async (req, res) => {
  try {
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.active === 'true') filter.isActive = true;
    if (req.query.active === 'false') filter.isActive = false;
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { username: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const users = await User.find(filter).select(SAFE_FIELDS).sort('-createdAt');
    res.json({ success: true, data: users });
  } catch (err) {
    console.error('getUsers error:', err);
    res.status(500).json({ success: false, message: 'تعذر جلب المستخدمين' });
  }
};

// GET /api/users/:id
const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(SAFE_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر جلب المستخدم' });
  }
};

// POST /api/users — إنشاء مستخدم إداري جديد
const createUser = async (req, res) => {
  try {
    const { name, username, password, role, phone } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ success: false, message: 'الاسم واسم المستخدم وكلمة المرور مطلوبة' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    const cleanUsername = String(username).toLowerCase().trim();
    const exists = await User.findOne({ username: cleanUsername });
    if (exists) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم مستخدم بالفعل' });
    }

    const allowedRoles = ['admin', 'manager', 'cashier', 'employee'];
    const finalRole = allowedRoles.includes(role) ? role : 'employee';

    const user = await User.create({
      name: String(name).trim(),
      username: cleanUsername,
      password, // تُجزَّأ تلقائياً عبر pre('save')
      role: finalRole,
      phone: (phone || '').trim(),
    });

    console.log(`👤 أنشأ ${req.user.username} مستخدماً جديداً: ${cleanUsername} (${finalRole})`);

    const safe = await User.findById(user._id).select(SAFE_FIELDS);
    res.status(201).json({ success: true, data: safe });
  } catch (err) {
    console.error('createUser error:', err);
    res.status(500).json({ success: false, message: 'تعذر إنشاء المستخدم' });
  }
};

// PUT /api/users/:id — تعديل بيانات مستخدم (بما فيها كلمة المرور اختيارياً)
const updateUser = async (req, res) => {
  try {
    const { name, username, role, phone, password, isActive } = req.body;
    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    // حماية: لا يجوز تعطيل آخر مدير نظام أو تنزيل رتبته
    if (user.role === 'admin' && (isActive === false || (role && role !== 'admin'))) {
      const admins = await User.countDocuments({ role: 'admin', isActive: true });
      if (admins <= 1) {
        return res.status(400).json({
          success: false,
          message: 'لا يمكن تعطيل آخر مدير نظام أو تغيير دوره. أنشئ مديراً آخر أولاً.',
        });
      }
    }

    if (username) {
      const cleanUsername = String(username).toLowerCase().trim();
      const clash = await User.findOne({ username: cleanUsername, _id: { $ne: user._id } });
      if (clash) return res.status(400).json({ success: false, message: 'اسم المستخدم مستخدم بالفعل' });
      user.username = cleanUsername;
    }
    if (name) user.name = String(name).trim();
    if (phone != null) user.phone = String(phone).trim();
    if (role && ['admin', 'manager', 'cashier', 'employee'].includes(role)) user.role = role;
    if (typeof isActive === 'boolean') user.isActive = isActive;

    if (password) {
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      }
      user.password = password; // تُجزَّأ تلقائياً
    }

    await user.save();
    console.log(`✏️ عدّل ${req.user.username} بيانات المستخدم: ${user.username}`);

    const safe = await User.findById(user._id).select(SAFE_FIELDS);
    res.json({ success: true, data: safe });
  } catch (err) {
    console.error('updateUser error:', err);
    res.status(500).json({ success: false, message: 'تعذر تعديل المستخدم' });
  }
};

// DELETE /api/users/:id — حذف مستخدم
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

    // حماية: لا يحذف المستخدم نفسه، ولا آخر مدير نظام
    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ success: false, message: 'لا يمكنك حذف حسابك الحالي' });
    }
    if (user.role === 'admin') {
      const admins = await User.countDocuments({ role: 'admin', isActive: true });
      if (admins <= 1) {
        return res.status(400).json({ success: false, message: 'لا يمكن حذف آخر مدير نظام' });
      }
    }

    await user.deleteOne();
    console.log(`🗑️ حذف ${req.user.username} المستخدم: ${user.username}`);
    res.json({ success: true, message: 'تم حذف المستخدم' });
  } catch (err) {
    console.error('deleteUser error:', err);
    res.status(500).json({ success: false, message: 'تعذر حذف المستخدم' });
  }
};

module.exports = { getUsers, getUser, createUser, updateUser, deleteUser };
