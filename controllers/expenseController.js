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

  expense.voided = true;
  expense.voidedByName = nameOf(req.user);
  expense.voidedAt = new Date();
  await expense.save();

  res.json({ success: true, expense });
};

module.exports = wrapAll({ createExpense, listExpenses, voidExpense });
