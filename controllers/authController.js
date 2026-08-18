const jwt = require('jsonwebtoken');
const User = require('../models/User');

const generateAccessToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });

const generateRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'الرجاء إدخال اسم المستخدم وكلمة المرور' });
    }

    const user = await User.findOne({ username: username.toLowerCase() }).select(
      '+password'
    );

    if (!user) {
      return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'هذا الحساب غير مفعل، تواصل مع الإدارة' });
    }

    const accessToken = generateAccessToken(user._id);
    const refreshToken = rememberMe ? generateRefreshToken(user._id) : null;

    if (refreshToken) {
      user.refreshToken = refreshToken;
      await user.save();
    }

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        permissions: user.permissions,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الدخول' });
  }
};

// POST /api/auth/refresh
const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ message: 'لا يوجد رمز تجديد' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id).select('+refreshToken');

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ message: 'رمز التجديد غير صالح' });
    }

    const accessToken = generateAccessToken(user._id);
    res.json({ accessToken });
  } catch (error) {
    return res.status(403).json({ message: 'رمز التجديد منتهي الصلاحية أو غير صالح' });
  }
};

// POST /api/auth/logout
const logout = async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId) {
      await User.findByIdAndUpdate(userId, { refreshToken: null });
    }
    res.json({ message: 'تم تسجيل الخروج بنجاح' });
  } catch (error) {
    res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الخروج' });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  res.json({ user: req.user });
};


// ─────────── تغيير بيانات الأدمن مع كود تأكيد يُسجَّل في سجلات الخادم ───────────
// نخزّن الطلب المعلّق في الذاكرة (كافٍ لخادم واحد). الكود لا يُرسل للواجهة إطلاقاً.
const pendingCredentialChanges = new Map(); // userId -> { code, newUsername, newPassword, expiresAt }
const CODE_TTL_MS = 10 * 60 * 1000; // 10 دقائق

// POST /api/auth/request-credential-change  { newUsername?, newPassword? }
const requestCredentialChange = async (req, res) => {
  try {
    const { newUsername, newPassword } = req.body;
    if (!newUsername && !newPassword) {
      return res.status(400).json({ message: 'الرجاء إدخال اسم مستخدم أو كلمة مرور جديدة' });
    }
    if (newPassword && String(newPassword).length < 6) {
      return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 أرقام
    pendingCredentialChanges.set(String(req.user._id), {
      code,
      newUsername: newUsername ? String(newUsername).toLowerCase().trim() : null,
      newPassword: newPassword || null,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    // يُسجَّل داخلياً في سجلات الخادم فقط — لا يُرسل في الرد
    console.log('==============================================');
    console.log(`🔐 كود تأكيد تغيير بيانات الأدمن (${req.user.username}): ${code}`);
    console.log('   صالح لمدة 10 دقائق. أدخله في لوحة التحكم لاعتماد التغيير.');
    console.log('==============================================');
    res.json({ success: true, message: 'تم توليد كود التأكيد. يمكنك الحصول عليه من مسؤول النظام أو المطوّر.' });
  } catch (err) {
    res.status(500).json({ message: 'تعذّر توليد كود التأكيد', error: err.message });
  }
};

// POST /api/auth/confirm-credential-change  { code }
const confirmCredentialChange = async (req, res) => {
  try {
    const { code } = req.body;
    const pending = pendingCredentialChanges.get(String(req.user._id));
    if (!pending) return res.status(400).json({ message: 'لا يوجد طلب تغيير معلّق. ابدأ من جديد.' });
    if (Date.now() > pending.expiresAt) {
      pendingCredentialChanges.delete(String(req.user._id));
      return res.status(400).json({ message: 'انتهت صلاحية الكود. ابدأ من جديد.' });
    }
    if (!code || String(code).trim() !== pending.code) {
      return res.status(400).json({ message: 'كود التأكيد غير صحيح' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

    if (pending.newUsername) {
      const clash = await User.findOne({ username: pending.newUsername, _id: { $ne: user._id } });
      if (clash) return res.status(400).json({ message: 'اسم المستخدم مستخدم بالفعل' });
      user.username = pending.newUsername;
    }
    if (pending.newPassword) {
      user.password = pending.newPassword; // يُجزَّأ تلقائياً عبر pre('save')
    }
    await user.save();
    pendingCredentialChanges.delete(String(req.user._id));

    res.json({ success: true, message: 'تم تحديث بيانات الأدمن بنجاح. الرجاء تسجيل الدخول من جديد.' });
  } catch (err) {
    res.status(500).json({ message: 'تعذّر اعتماد التغيير', error: err.message });
  }
};


// ─────────── تغيير كلمة المرور بالطريقة الاحترافية (كلمة المرور الحالية) ───────────
// POST /api/auth/change-password  { currentPassword, newPassword, confirmPassword }
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'الرجاء تعبئة جميع الحقول' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'كلمة المرور الجديدة وتأكيدها غير متطابقين' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' });
    }

    // نجلب المستخدم مع كلمة المرور (select:false في النموذج) للتحقق منها
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'كلمة المرور الحالية غير صحيحة' });
    }

    user.password = newPassword; // تُجزَّأ تلقائياً عبر pre('save') — لا تُخزَّن مكشوفة أبداً
    await user.save();

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح. الرجاء تسجيل الدخول من جديد.' });
  } catch (err) {
    res.status(500).json({ message: 'تعذّر تغيير كلمة المرور', error: err.message });
  }
};


// ─────────── استعادة كلمة مرور الأدمن عبر واتساب ───────────
// لا نستخدم SMS/OTP خارجي. يُولَّد رمز ويُرسَل إلى واتساب المدير عبر رابط wa.me
// (يفتحه المتصفح تلقائياً)، ويبقى صالحاً مدة طويلة (30 دقيقة) كما طُلب.
const passwordResets = new Map(); // key: userId → { hash, expiresAt, attempts }
const RESET_TTL_MS = 30 * 60 * 1000; // 30 دقيقة
const MAX_RESET_ATTEMPTS = 5;

const hashResetCode = (code) =>
  require('crypto').createHash('sha256').update(String(code)).digest('hex');

// يحوّل الرقم الأردني المحلي إلى الصيغة الدولية لواتساب
const toIntlJo = (phone) => {
  let p = String(phone || '').replace(/[\s\-+]/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('962')) return p;
  if (p.startsWith('0')) return '962' + p.slice(1);
  return '962' + p;
};

// POST /api/auth/forgot-password  { phone }
// يتحقق أن الرقم يطابق رقم مدير مسجّل، ثم يُرجع رابط واتساب يحمل الرمز
const forgotPassword = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'الرجاء إدخال رقم الهاتف' });

    const clean = String(phone).replace(/[\s\-+]/g, '');
    const user = await User.findOne({ phone: clean, isActive: true });

    // رسالة عامة لا تكشف تفاصيل تقنية ولا تؤكد وجود الرقم من عدمه
    // رسالة موحّدة لا تكشف إن كان الحساب موجوداً أم لا (حماية من تعداد الحسابات)
    const genericMsg = 'إذا كان الحساب موجوداً، سيتم إرسال تعليمات استعادة كلمة المرور.';
    if (!user) return res.status(200).json({ success: true, message: genericMsg });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    passwordResets.set(String(user._id), {
      hash: hashResetCode(code),
      expiresAt: Date.now() + RESET_TTL_MS,
      attempts: 0,
    });

    const text = `رمز استعادة كلمة المرور الخاص بلوحة التحكم: ${code}\nالرمز صالح لمدة 30 دقيقة. لا تشاركه مع أي شخص.`;
    const whatsappUrl = `https://wa.me/${toIntlJo(clean)}?text=${encodeURIComponent(text)}`;

    res.json({
      success: true,
      userId: String(user._id),
      whatsappUrl,
      message: 'تم توليد رمز التحقق وسيُفتح واتساب لإرساله إلى رقمك.',
    });
  } catch (err) {
    console.error('forgotPassword error:', err); // التفاصيل التقنية داخلياً فقط
    res.status(500).json({ message: 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً أو التواصل مع المطوّر.' });
  }
};

// POST /api/auth/reset-password  { userId, code, newPassword, confirmPassword }
const resetPassword = async (req, res) => {
  try {
    const { userId, code, newPassword, confirmPassword } = req.body;
    if (!userId || !code || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'الرجاء تعبئة جميع الحقول' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'كلمة المرور الجديدة وتأكيدها غير متطابقين' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    const pending = passwordResets.get(String(userId));
    if (!pending) return res.status(400).json({ message: 'لا يوجد طلب استعادة صالح. ابدأ من جديد.' });
    if (Date.now() > pending.expiresAt) {
      passwordResets.delete(String(userId));
      return res.status(400).json({ message: 'انتهت صلاحية الرمز. ابدأ من جديد.' });
    }
    if (pending.attempts >= MAX_RESET_ATTEMPTS) {
      passwordResets.delete(String(userId));
      return res.status(429).json({ message: 'تجاوزت عدد المحاولات المسموح. ابدأ من جديد.' });
    }
    if (hashResetCode(code) !== pending.hash) {
      pending.attempts += 1;
      return res.status(400).json({ message: 'رمز التحقق غير صحيح' });
    }

    const user = await User.findById(userId).select('+password');
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

    user.password = newPassword; // يُجزَّأ تلقائياً
    await user.save();
    passwordResets.delete(String(userId));

    res.json({ success: true, message: 'تم تعيين كلمة المرور الجديدة بنجاح.' });
  } catch (err) {
    console.error('resetPassword error:', err);
    res.status(500).json({ message: 'تعذر تعيين كلمة المرور. يرجى المحاولة لاحقاً.' });
  }
};

module.exports = { login, refresh, logout, getMe, requestCredentialChange, confirmCredentialChange, changePassword, forgotPassword, resetPassword };