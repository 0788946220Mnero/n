const { wrapAll } = require('../utils/asyncHandler');
const Expense = require('../models/Expense');
const ExpenseSequence = require('../models/ExpenseSequence');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const isManager = (u) => !!u && ['admin', 'manager'].includes(u.role);

/** رقم سند تسلسلي ذرّي — لا يتكرر حتى مع تسجيلين في نفس اللحظة. */
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

  const expense = await Expense.create({
    number: await nextNumber(),
    name,
    amount: Number(amount.toFixed(3)),
    paidTo: String((req.body && req.body.paidTo) || '').trim().slice(0, 80),
    brand: (req.body && req.body.brand) || 'diyar',
    createdBy: req.user._id,
    createdByName: nameOf(req.user),
  });

  console.log(`💸 مصروف #${expense.number} «${name}» ${expense.amount} د.أ بواسطة ${req.user.username}`);
  res.status(201).json({ success: true, expense });
};

// GET /api/expenses?scope=mine|all — مصروفات الجرد المفتوح
const listExpenses = async (req, res) => {
  const filter = { closed: { $ne: true } };
  const all = req.query.scope === 'all' && isManager(req.user);
  if (!all) filter.createdBy = req.user._id;

  const expenses = await Expense.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, expenses, scope: all ? 'all' : 'mine' });
};

// PATCH /api/expenses/:id/void — للمدير وحده، وقبل إغلاق الجرد فقط
const voidExpense = async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'إلغاء المصروفات للمدير فقط' });
  }

  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ message: 'المصروف غير موجود' });
  if (expense.closed) return res.status(400).json({ message: 'أُغلق جرد هذا المصروف، فلا يمكن إلغاؤه' });
  if (expense.voided) return res.status(400).json({ message: 'المصروف ملغى مسبقاً' });

  require('../utils/activity').logActivity({ req, action: 'expense.void', amount: expense.amount, details: { name: expense.name, number: expense.number } });
  expense.voided = true;
  expense.voidedByName = nameOf(req.user);
  expense.voidedAt = new Date();
  await expense.save();

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
  if (req.query.status === 'open') { f.closed = { $ne: true }; f.voided = { $ne: true }; }
  if (req.query.status === 'closed') { f.closed = true; f.voided = { $ne: true }; }
  if (req.query.status === 'voided') f.voided = true;
  if (req.query.shiftId) f.shiftId = String(req.query.shiftId).trim();
  if (req.query.q) {
    const q = String(req.query.q).trim();
    const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    f.$or = [{ name: rx }, { createdByName: rx }, { paidTo: rx }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])];
  }

  const [data, total, sums] = await Promise.all([
    Expense.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
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

module.exports = wrapAll({ createExpense, listExpenses, voidExpense, logExpenses });
