const { wrapAll } = require('../utils/asyncHandler');
const Expense = require('../models/Expense');
const ExpenseSequence = require('../models/ExpenseSequence');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const isManager = (u) => !!u && ['admin', 'manager'].includes(u.role);
/** يرى مصروفات الجميع: المدير والمشرف، ومن يملك «المصروفات: عرض» (مراقب البيانات). */
const seesAll = (u) => isManager(u) || require('../middlewares/permission').hasPermission(u, 'expenses:view');

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
  if (!seesAll(req.user) && String(e.createdBy) !== String(req.user._id) && !employeeVoucher) {
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

const capitalBalance = async (session) => {
  const CapitalEntry = require('../models/CapitalEntry');
  let q = CapitalEntry.find({ voided: { $ne: true } }).select('type amount');
  if (session) q = q.session(session);
  const all = await q.lean();
  return all.reduce((t, e) => t + CapitalEntry.signed(e), 0);
};

// GET /api/expenses/meta — التصنيفات ووسائل الدفع والمصادر (مصدر واحد للواجهة)
const meta = async (req, res) => {
  const C = require('../utils/expenseCategories');
  res.json({ success: true, categories: C.CATEGORIES.filter((c) => C.PICKABLE.includes(c.key)), allCategories: C.CATEGORIES, methods: C.METHODS, sources: C.SOURCES, accounts: C.ACCOUNTS });
};

/**
 * POST /api/expenses
 *   { name, amount, source: drawer|capital, paymentMethod: cash|cliq, category, paidTo?, reference?, notes?,
 *     clientRef?, spentAt?, employee?, kind?, signature? }
 *
 * مصدر التمويل ووسيلة الدفع إلزاميان ومنفصلان — لا يُفترض أحدهما من الآخر:
 *   صندوق + نقداً  ← يُخصم من النقد المتوقع في درج من سجّله
 *   صندوق + كليك   ← يُخصم من رصيد كليك المتوقع في جرده (لا من النقد)
 *   رأس المال + أي وسيلة ← حركة واحدة على رأس المال، ولا يدخل أي جرد (الوسيلة للتوثيق)
 * لا يُخصم المصروف من رصيدين أبداً، ولا تُنشأ حركة تحويل بين حسابين.
 * السند وحركة رأس المال يُكتبان معاً أو لا يُكتب أيٌّ منهما (معاملة، أو تعويض حين لا تتوفر).
 */
const createExpense = async (req, res) => {
  const C = require('../utils/expenseCategories');
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const amount = Number(b.amount);

  if (!name) return res.status(400).json({ message: 'اكتب اسم المصروف' });
  if (name.length > 120) return res.status(400).json({ message: 'اسم المصروف طويل جداً' });
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'قيمة المصروف يجب أن تكون أكبر من صفر' });
  }
  if (amount > 100000) return res.status(400).json({ message: 'قيمة المصروف غير منطقية' });

  // ── مصدر التمويل ووسيلة الدفع: يختارهما من يصرف صراحةً ──
  if (!['drawer', 'capital'].includes(b.source)) {
    return res.status(400).json({ code: 'SOURCE_REQUIRED', message: 'اختر مصدر التمويل: الصندوق أو رأس المال (إن لم تظهر الخيارات حدّث الصفحة)' });
  }
  if (!['cash', 'cliq'].includes(b.paymentMethod)) {
    return res.status(400).json({ code: 'METHOD_REQUIRED', message: 'اختر وسيلة الدفع: نقداً أو كليك (إن لم تظهر الخيارات حدّث الصفحة)' });
  }
  const source = b.source;
  const paymentMethod = b.paymentMethod;
  const account = `${source}_${paymentMethod}`;
  const reference = String(b.reference || '').trim().slice(0, 80);
  const notes = String(b.notes || '').trim().slice(0, 300);
  const clientRef = String(b.clientRef || '').trim().slice(0, 64) || null;

  // إعادة إرسال نفس العملية (نقرة مزدوجة / انقطاع): السند الأول كما هو، بلا حركة ثانية
  if (clientRef) {
    const dup = await Expense.findOne({ clientRef }).select('-approvedSignature').lean();
    if (dup) {
      if (String(dup.createdBy) !== String(req.user._id)) return res.status(409).json({ code: 'REF_TAKEN', message: 'معرّف العملية مستخدم — أعد فتح نافذة الصرف' });
      res.locals.auditSkip = true;
      return res.json({ success: true, duplicate: true, expense: dup });
    }
  }

  const { hasPermission } = require('../middlewares/permission');
  const CapitalEntry = require('../models/CapitalEntry');
  if (source === 'capital') {
    if (!hasPermission(req.user, 'capital:manage')) {
      return res.status(403).json({ message: 'الصرف من رأس المال يحتاج صلاحية «رأس المال»' });
    }
    const balance = await capitalBalance(null);
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
  // التصنيف: صرف الموظف «رواتب وأجور» دائماً، وغيره يختاره من يصرف
  const category = employee ? 'salaries' : String(b.category || '').trim();
  if (!C.PICKABLE.includes(category)) {
    return res.status(400).json({ code: 'CATEGORY_REQUIRED', message: 'اختر تصنيف المصروف' });
  }

  // تاريخ الصرف: لا مستقبلي، ولا أقدم من سنة
  let spentAt = new Date();
  if (req.body && req.body.spentAt) {
    const t = new Date(req.body.spentAt);
    const now = Date.now();
    if (!isNaN(t) && t.getTime() <= now + 60000 && t.getTime() >= now - 366 * 86400000) spentAt = t;
  }

  const doc = {
    number: await nextNumber(),
    name,
    amount: Number(amount.toFixed(3)),
    source,
    paymentMethod,
    account,
    category,
    reference,
    notes,
    clientRef,
    employee: employee ? employee._id : null,
    employeeName: employee ? employee.name : '',
    kind,
    spentAt,
    ...(employee ? { approvedByName: nameOf(req.user), approvedByRole: req.user.role || '', approvedAt: new Date(), approvedSignature: signature } : {}),
    paidTo: String((req.body && req.body.paidTo) || (employee ? employee.name : '')).trim().slice(0, 80),
    brand: (req.body && req.body.brand) || 'diyar',
    createdBy: req.user._id,
    createdByName: nameOf(req.user),
  };
  const capitalDoc = (e) => ({
    type: 'expense', amount: e.amount, note: name, date: spentAt, paymentMethod,
    expense: e._id, expenseNumber: e.number,
    createdBy: req.user._id, createdByName: nameOf(req.user),
  });

  let expense;
  try {
    expense = await require('../utils/txn').withTxn(async (session) => {
      if (session) {
        // داخل المعاملة: الرصيد يُقرأ ويُخصم معاً، والسند والحركة يُكتبان أو يُلغيان معاً
        if (source === 'capital' && amount > (await capitalBalance(session)) + 1e-9) {
          throw Object.assign(new Error('رصيد رأس المال لا يكفي لهذا الصرف'), { status: 400 });
        }
        const [e] = await Expense.create([doc], { session });
        if (source === 'capital') await CapitalEntry.create([capitalDoc(e)], { session });
        return e;
      }
      // بلا معاملات (قاعدة مستقلة): السند أولاً، وإن تعذّرت حركة رأس المال يُحذف السند — لا يبقى أثر جزئي
      const e = await Expense.create(doc);
      if (source === 'capital') {
        try { await CapitalEntry.create(capitalDoc(e)); } catch (err) {
          await Expense.deleteOne({ _id: e._id }).catch(() => {});
          throw err;
        }
      }
      return e;
    });
  } catch (err) {
    // سباق نادر: نفس معرّف العملية وصل مرتين في اللحظة نفسها — نعيد السند الذي سُجّل
    if (err && err.code === 11000 && clientRef) {
      const dup = await Expense.findOne({ clientRef }).select('-approvedSignature').lean();
      if (dup) { res.locals.auditSkip = true; return res.json({ success: true, duplicate: true, expense: dup }); }
    }
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
  console.log(`💸 مصروف #${expense.number} «${name}» ${expense.amount} د.أ (${C.SOURCES[source]} · ${C.METHODS[paymentMethod]}) بواسطة ${req.user.username}`);
  require('../services/liveReportService').touch(); // التقرير الحي: المصروفات تغيّرت
  res.status(201).json({ success: true, expense });
};

// GET /api/expenses?scope=mine|all — مصروفات الجرد المفتوح
const listExpenses = async (req, res) => {
  const filter = { closed: { $ne: true }, source: { $ne: 'capital' } }; // مصروفات الجرد (الصندوق) فقط
  const all = req.query.scope === 'all' && seesAll(req.user);
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

  // قسط التزام ثابت: يُلغى ما دامت دورته مفتوحة (بعد موعدها سُدّدت أو صُدّرت للذمم)
  let obligationCycle = null;
  if (expense.obligationCycle) {
    obligationCycle = await require('../models/ObligationCycle').findById(expense.obligationCycle).lean();
    if (!obligationCycle || obligationCycle.status !== 'open') {
      return res.status(400).json({ message: 'انتهت دورة هذا الالتزام (سُدّدت أو صُدِّر متبقيها لذمم الموردين) — لا يُلغى قسطها' });
    }
  }
  require('../utils/activity').logActivity({ req, action: 'expense.void', amount: expense.amount, details: { name: expense.name, number: expense.number } });
  const now = new Date();
  const by = nameOf(req.user);
  const ObligationCycle = require('../models/ObligationCycle');
  const CapitalEntry = require('../models/CapitalEntry');
  // السند وحركة رأس المال وقسط الالتزام تُلغى معاً أو لا يُلغى شيء
  await require('../utils/txn').withTxn(async (session) => {
    const o = session ? { session } : {};
    // شرط «غير ملغى» يمنع إلغاءين متزامنين من إرجاع المبلغ مرتين
    const r = await Expense.updateOne({ _id: expense._id, voided: { $ne: true } }, { $set: { voided: true, voidedByName: by, voidedAt: now } }, o);
    if (!(r.modifiedCount || r.nModified)) throw Object.assign(new Error('المصروف ملغى مسبقاً'), { status: 400 });
    try {
      // يعود المبلغ للمتبقي فيُوزَّع على الأيام الباقية
      if (obligationCycle) await ObligationCycle.updateOne({ _id: obligationCycle._id }, { $inc: { paid: -Number(expense.amount), payments: -1 } }, o);
      // حركة رأس المال المرتبطة تُلغى فيعود المبلغ للرصيد
      if (expense.source === 'capital') {
        await CapitalEntry.updateMany({ expense: expense._id, voided: { $ne: true } }, { $set: { voided: true, voidedAt: now, voidedByName: by } }, o);
      }
    } catch (err) {
      if (!session) { // بلا معاملات: نعيد السند كما كان فلا يبقى إلغاء جزئي
        await Expense.updateOne({ _id: expense._id }, { $set: { voided: false, voidedByName: '', voidedAt: null } }).catch(() => {});
      }
      throw err;
    }
  }).catch((err) => { if (err && err.status) { res.status(err.status).json({ message: err.message }); return null; } throw err; });
  if (res.headersSent) return undefined;
  expense.voided = true; expense.voidedByName = by; expense.voidedAt = now;

  require('../services/liveReportService').touch(); // التقرير الحي: أُلغي مصروف
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
  if (!seesAll(req.user)) f.createdBy = req.user._id;
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
  // وسيلة الدفع: «نقداً» يشمل السندات القديمة بلا وسيلة (كانت تُحسب نقداً)
  if (req.query.method === 'cash') f.paymentMethod = { $in: ['cash', ''] };
  if (req.query.method === 'cliq') f.paymentMethod = 'cliq';
  if (req.query.category && /^[a-z]{2,20}$/.test(req.query.category)) f.category = req.query.category;
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

/**
 * GET /api/expenses/report?from=YYYY-MM-DD&to=&user=&category=&source=&method=
 * تقرير الجرد المالي لفترة:
 *   • المصروفات حسب مصدر التمويل، ووسيلة الدفع، والحساب الفعلي، والتصنيف، والموظف
 *   • المتوقع في الصندوق (نقداً) وفي كليك للفترة: المبيعات − المصروفات − تسديد الموردين
 *     (نفس حساب الجرد — summarizeOrders — لا رقم ثانٍ)
 *   • دورات الجرد المغلقة في الفترة: المتوقع مقابل الفعلي والفرق وسببه حين سُجّل
 * لمن يرى مصروفات الجميع فقط (المدير والمشرف ومراقب البيانات).
 */
const report = async (req, res) => {
  if (!seesAll(req.user)) return res.status(403).json({ message: 'تقرير الجرد للمدير ومن يملك «المصروفات: عرض»' });
  const mongoose = require('mongoose');
  const C = require('../utils/expenseCategories');
  const Order = require('../models/Order');
  const Receivable = require('../models/Receivable');
  const ShiftSession = require('../models/ShiftSession');
  const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const day = (s) => new Date(`${s}T00:00:00+03:00`);
  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const from = ymd(req.query.from) ? req.query.from : today;
  const to = ymd(req.query.to) ? req.query.to : from;
  if (to < from) return res.status(400).json({ message: 'نهاية الفترة قبل بدايتها' });
  if ((day(to) - day(from)) / 86400000 > 370) return res.status(400).json({ message: 'الفترة أطول من سنة — اختر فترة أقصر' });
  const range = { $gte: day(from), $lt: new Date(day(to).getTime() + 86400000) };
  const user = req.query.user && mongoose.Types.ObjectId.isValid(req.query.user) ? new mongoose.Types.ObjectId(req.query.user) : null;

  // المصروفات: بتاريخ الصرف الفعلي (والقديمة بلا تاريخ صرف: بتاريخ التسجيل)
  const ef = { voided: { $ne: true }, $or: [{ spentAt: range }, { spentAt: null, createdAt: range }] };
  if (user) ef.createdBy = user;
  if (C.CATEGORY_KEYS.includes(req.query.category)) ef.category = req.query.category;
  if (['drawer', 'capital'].includes(req.query.source)) ef.source = req.query.source === 'drawer' ? { $ne: 'capital' } : 'capital';
  if (req.query.method === 'cash') ef.paymentMethod = { $in: ['cash', ''] };
  if (req.query.method === 'cliq') ef.paymentMethod = 'cliq';
  const expenses = await Expense.find(ef).select('amount source paymentMethod account category createdBy createdByName kind').lean();

  const group = (keyOf, labelOf) => {
    const m = new Map();
    for (const e of expenses) {
      const k = keyOf(e);
      const g = m.get(k) || { key: k, label: labelOf(k, e), count: 0, amount: 0 };
      g.count += 1; g.amount += Number(e.amount || 0);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, amount: Number(g.amount.toFixed(3)) })).sort((a, b) => b.amount - a.amount);
  };
  const total = Number(expenses.reduce((t, e) => t + Number(e.amount || 0), 0).toFixed(3));

  // المتوقع للفترة من حساب الجرد نفسه: طلبات الفترة (مؤرشفة أو لا) ومصروفات الصندوق وتسديد الموردين من الدرج
  const of = { createdAt: range };
  if (user) of.handledBy = user;
  const rf = { status: 'paid', deleted: { $ne: true }, paySource: { $ne: 'capital' }, paidAt: range };
  if (user) rf.$or = [{ drawerUser: user }, { drawerUser: null, paidBy: user }];
  const [orders, collections] = await Promise.all([
    Order.find(of).select('status source total deliveryFee paymentMethod items createdAt').lean(),
    Receivable.find(rf).select('amount paymentMethod').lean(),
  ]);
  const drawerExp = expenses.filter((e) => C.sourceOf(e) === 'drawer');
  const s = require('./orderController').summarizeOrders(orders, drawerExp, null, collections);

  const sf = { status: 'closed', closedAt: range };
  if (user) sf.user = user;
  const shifts = await ShiftSession.find(sf).sort({ closedAt: -1 }).limit(200)
    .select('shiftId scope userName closedAt closedByName cashNet cliqNet actualCash actualCliq cashDiff cliqDiff diffReason').lean();

  res.json({
    success: true,
    range: { from, to },
    totals: { count: expenses.length, amount: total },
    bySource: group(C.sourceOf, (k) => C.SOURCES[k]),
    byMethod: group(C.methodOf, (k) => C.METHODS[k]),
    byAccount: group(C.accountOf, (k) => C.ACCOUNTS[k] || k),
    byCategory: group((e) => e.category || '', (k) => C.categoryLabel(k)),
    byUser: group((e) => String(e.createdBy || ''), (k, e) => e.createdByName || '—'),
    expected: {
      // ما يجب أن يكون في الصندوق نقداً، وفي كليك، عن حركات هذه الفترة
      cash: s.cashNet, cliq: s.cliqNet,
      cashSales: s.cashTotal, cliqSales: s.cliqTotal,
      cashExpenses: s.expensesCash, cliqExpenses: s.expensesCliq,
      supplierCash: s.supplierPaymentsCash, supplierCliq: s.supplierPaymentsCliq,
      capitalExpenses: Number(expenses.filter((e) => C.sourceOf(e) === 'capital').reduce((t, e) => t + Number(e.amount || 0), 0).toFixed(3)),
    },
    shifts: shifts.map((x) => ({
      shiftId: x.shiftId, scope: x.scope, userName: x.userName, closedAt: x.closedAt, closedByName: x.closedByName,
      expectedCash: x.cashNet, expectedCliq: x.cliqNet || 0,
      actualCash: x.actualCash, actualCliq: x.actualCliq, cashDiff: x.cashDiff, cliqDiff: x.cliqDiff, diffReason: x.diffReason || '',
    })),
  });
};

module.exports = wrapAll({ createExpense, listExpenses, voidExpense, logExpenses, getSignature, setSignature, getExpense, meta, report });
// رقم سند الصرف التسلسلي — يستعمله «الالتزامات الثابتة» لأقساطه اليومية (نفس تسلسل السندات)
module.exports.nextExpenseNumber = nextNumber;
module.exports.validSignature = validSignature;
