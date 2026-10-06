const { wrapAll } = require('../utils/asyncHandler');
const Expense = require('../models/Expense');
const ExpenseSequence = require('../models/ExpenseSequence');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const isManager = (u) => !!u && ['admin', 'manager'].includes(u.role);

/** رقم سند تسلسلي ذرّي — لا يتكرر حتى مع تسجيلين في نفس اللحظة. */
/** توقيع صالح: صورة PNG صغيرة (data URL) — لا نصوص ولا ملفات كبيرة. */
const validSignature = (s) => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 300000;

// GET/PUT /api/expenses/signature — توقيع المستخدم المحفوظ (لمن يملك الصرف للموظفين)
const canPayEmployees = (u) => require('../middlewares/permission').hasPermission(u, 'employees:pay');
const getSignature = async (req, res) => {
  if (!canPayEmployees(req.user)) return res.status(403).json({ message: 'لمن يملك صلاحية الصرف للموظفين' });
  const me = await require('../models/User').findById(req.user._id).select('+signature').lean();
  res.json({ success: true, signature: (me && me.signature) || '' });
};
const setSignature = async (req, res) => {
  if (!canPayEmployees(req.user)) return res.status(403).json({ message: 'لمن يملك صلاحية الصرف للموظفين' });
  const sig = String((req.body && req.body.signature) || '');
  if (sig && !validSignature(sig)) return res.status(400).json({ message: 'صورة التوقيع غير صالحة' });
  await require('../models/User').updateOne({ _id: req.user._id }, { $set: { signature: sig } });
  res.json({ success: true });
};

// GET /api/expenses/:id — السند كاملاً للطباعة (مع توقيع الاعتماد)
const getExpense = async (req, res) => {
  const mongoose = require('mongoose');
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const e = await Expense.findById(req.params.id).lean();
  if (!e) return res.status(404).json({ message: 'السند غير موجود' });
  const { hasPermission } = require('../middlewares/permission');
  const employeeVoucher = !!e.employee && (hasPermission(req.user, 'employees:pay') || hasPermission(req.user, 'employees:manage'));
  if (!isManager(req.user) && String(e.createdBy) !== String(req.user._id) && !employeeVoucher) {
    return res.status(403).json({ message: 'ليس لديك صلاحية' });
  }
  res.json({ success: true, expense: e });
};

const nextNumber = async () => {
  // تسجيلان متزامنان عند أول إنشاء للعدّاد قد يتصادمان على _id (خطأ 11000
  // معروف مع upsert)؛ المحاولة الثانية تجده موجوداً فتزيده فقط
  for (let attempt = 1; ; attempt++) {
    try {
      const c = await ExpenseSequence.findOneAndUpdate(
        { _id: 'expense' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      return c.seq;
    } catch (err) {
      if (err && err.code === 11000 && attempt < 3) continue;
      throw err;
    }
  }
};

// POST /api/expenses  { name, amount }
const createExpense = async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const amount = Number(req.body && req.body.amount);

  if (!name) return res.status(400).json({ message: 'اكتب اسم المصروف' });
  if (name.length > 120) return res.status(400).json({ message: 'اسم المصروف طويل جداً' });
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'قيمة المصروف يجب أن تكون أكبر من صفر' });
  }
  if (amount > 100000) return res.status(400).json({ message: 'قيمة المصروف غير منطقية' });

  // ── المصدر: الصندوق (افتراضي) أو رأس المال ──
  const source = req.body && req.body.source === 'capital' ? 'capital' : 'drawer';
  const { hasPermission } = require('../middlewares/permission');
  const CapitalEntry = require('../models/CapitalEntry');
  if (source === 'capital') {
    if (!hasPermission(req.user, 'capital:manage')) {
      return res.status(403).json({ message: 'الصرف من رأس المال يحتاج صلاحية «رأس المال»' });
    }
    const all = await CapitalEntry.find({ voided: { $ne: true } }).select('type amount').lean();
    const balance = all.reduce((t, e) => t + CapitalEntry.signed(e), 0);
    if (amount > balance + 1e-9) {
      return res.status(400).json({ message: `رصيد رأس المال (${balance.toFixed(3)}) لا يكفي لهذا الصرف` });
    }
  }

  // ── موظف (اختياري) — صرف الموظفين لمدير النظام وحده، وبتوقيعه ──
  let employee = null;
  let signature = '';
  const empId = req.body && req.body.employee;
  if (empId) {
    // صلاحية «صرف للموظفين»: لمدير النظام دائماً، ولمن يمنحه إياها
    if (!hasPermission(req.user, 'employees:pay')) {
      return res.status(403).json({ message: 'ليس لديك صلاحية الصرف للموظفين — يمنحها مدير النظام من «المستخدمون»' });
    }
    const User = require('../models/User');
    const sent = String((req.body && req.body.signature) || '');
    if (sent) {
      if (!validSignature(sent)) return res.status(400).json({ message: 'صورة التوقيع غير صالحة' });
      signature = sent;
      await User.updateOne({ _id: req.user._id }, { $set: { signature } }); // يُحفظ للسندات القادمة
    } else {
      const me = await User.findById(req.user._id).select('+signature').lean();
      signature = (me && me.signature) || '';
    }
    if (!signature) return res.status(400).json({ code: 'SIGNATURE_REQUIRED', message: 'وقّع على السند أولاً — توقيع من يصرف مطلوب لصرف الموظفين' });
    if (!require('mongoose').Types.ObjectId.isValid(empId)) return res.status(400).json({ message: 'موظف غير صالح' });
    employee = await require('../models/Employee').findById(empId).lean();
    if (!employee) return res.status(400).json({ message: 'الموظف غير موجود' });
  }
  const kind = employee
    ? (['salary', 'advance', 'bonus', 'other'].includes(req.body.kind) ? req.body.kind : 'other')
    : 'general';

  // تاريخ الصرف: لا مستقبلي، ولا أقدم من سنة
  let spentAt = new Date();
  if (req.body && req.body.spentAt) {
    const t = new Date(req.body.spentAt);
    const now = Date.now();
    if (!isNaN(t) && t.getTime() <= now + 60000 && t.getTime() >= now - 366 * 86400000) spentAt = t;
  }

  const expense = await Expense.create({
    number: await nextNumber(),
    name,
    amount: Number(amount.toFixed(3)),
    source,
    employee: employee ? employee._id : null,
    employeeName: employee ? employee.name : '',
    kind,
    spentAt,
    ...(employee ? { approvedByName: nameOf(req.user), approvedByRole: req.user.role || '', approvedAt: new Date(), approvedSignature: signature } : {}),
    paidTo: String((req.body && req.body.paidTo) || (employee ? employee.name : '')).trim().slice(0, 80),
    brand: (req.body && req.body.brand) || 'diyar',
    createdBy: req.user._id,
    createdByName: nameOf(req.user),
  });

  if (source === 'capital') {
    await CapitalEntry.create({
      type: 'expense', amount: expense.amount, note: name, date: spentAt,
      expense: expense._id, expenseNumber: expense.number,
      createdBy: req.user._id, createdByName: nameOf(req.user),
    });
  }
  console.log(`💸 مصروف #${expense.number} «${name}» ${expense.amount} د.أ بواسطة ${req.user.username}`);
  res.status(201).json({ success: true, expense });
};

// GET /api/expenses?scope=mine|all — مصروفات الجرد المفتوح
const listExpenses = async (req, res) => {
  const filter = { closed: { $ne: true }, source: { $ne: 'capital' } }; // مصروفات الجرد (الصندوق) فقط
  const all = req.query.scope === 'all' && isManager(req.user);
  if (!all) filter.createdBy = req.user._id;

  const expenses = await Expense.find(filter).select('-approvedSignature').sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, expenses, scope: all ? 'all' : 'mine' });
};

// PATCH /api/expenses/:id/void — للمدير وحده، وقبل إغلاق الجرد فقط
const voidExpense = async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'إلغاء المصروفات للمدير فقط' });
  }

  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ message: 'المصروف غير موجود' });
  if (expense.closed && expense.source !== 'capital') return res.status(400).json({ message: 'أُغلق جرد هذا المصروف، فلا يمكن إلغاؤه' });
  if (expense.voided) return res.status(400).json({ message: 'المصروف ملغى مسبقاً' });

  require('../utils/activity').logActivity({ req, action: 'expense.void', amount: expense.amount, details: { name: expense.name, number: expense.number } });
  expense.voided = true;
  expense.voidedByName = nameOf(req.user);
  expense.voidedAt = new Date();
  await expense.save();
  if (expense.source === 'capital') {
    // حركة رأس المال المرتبطة تُلغى فيعود المبلغ للرصيد
    await require('../models/CapitalEntry').updateMany(
      { expense: expense._id, voided: { $ne: true } },
      { $set: { voided: true, voidedAt: new Date(), voidedByName: nameOf(req.user) } }
    );
  }

  res.json({ success: true, expense });
};

/**
 * GET /api/expenses/log — سجل المصروف الكامل (بديل الدفتر الورقي)
 *   ?from=YYYY-MM-DD&to=&user=&status=open|closed|voided&q=&shiftId=&page=&limit=
 * المدير والأدمن يريان الكل، وغيرهما مصروفاته فقط. المجموع للفلتر كله (لا للصفحة).
 */
const logExpenses = async (req, res) => {
  const mongoose = require('mongoose');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const f = {};
  if (!isManager(req.user)) f.createdBy = req.user._id;
  else if (req.query.user && mongoose.Types.ObjectId.isValid(req.query.user)) f.createdBy = new mongoose.Types.ObjectId(req.query.user);

  const day = (s) => new Date(`${s}T00:00:00+03:00`);
  const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  if (ymd(req.query.from) || ymd(req.query.to)) {
    f.createdAt = {};
    if (ymd(req.query.from)) f.createdAt.$gte = day(req.query.from);
    if (ymd(req.query.to)) f.createdAt.$lt = new Date(day(req.query.to).getTime() + 86400000);
  }
  if (req.query.status === 'open') { f.closed = { $ne: true }; f.voided = { $ne: true }; f.source = { $ne: 'capital' }; }
  if (req.query.status === 'closed') { f.closed = true; f.voided = { $ne: true }; }
  if (req.query.status === 'voided') f.voided = true;
  if (req.query.shiftId) f.shiftId = String(req.query.shiftId).trim();
  if (['drawer', 'capital'].includes(req.query.source)) f.source = req.query.source === 'drawer' ? { $ne: 'capital' } : 'capital';
  if (req.query.employee && mongoose.Types.ObjectId.isValid(req.query.employee)) f.employee = new mongoose.Types.ObjectId(req.query.employee);
  if (req.query.kind && ['general', 'salary', 'advance', 'bonus', 'other'].includes(req.query.kind)) f.kind = req.query.kind;
  if (req.query.q) {
    const q = String(req.query.q).trim();
    const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    f.$or = [{ name: rx }, { createdByName: rx }, { paidTo: rx }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])];
  }

  const [data, total, sums] = await Promise.all([
    Expense.find(f).select('-approvedSignature').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Expense.countDocuments(f),
    // المجموع لا يشمل الملغاة (تبقى ظاهرة للمراجعة فقط)
    // فلتر «ملغاة» مجموعه صفر بطبيعته — لا نكتب شرط «غير ملغى» فوق شرطه
    req.query.status === 'voided'
      ? Promise.resolve([])
      : Expense.aggregate([{ $match: { ...f, voided: { $ne: true } } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  const t = sums[0] || { amount: 0, count: 0 };
  res.json({
    success: true,
    data,
    totals: { count: t.count, amount: Number(Number(t.amount || 0).toFixed(3)) },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

module.exports = wrapAll({ createExpense, listExpenses, voidExpense, logExpenses, getSignature, setSignature, getExpense });
