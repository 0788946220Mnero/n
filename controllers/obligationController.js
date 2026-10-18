/*
  الالتزامات الثابتة — واجهة الخادم.
  الإنشاء والتعديل والتوقيع: «obligations:manage» (مدير النظام افتراضياً) — وبتوقيعه.
  دفع قسط اليوم: «obligations:pay» (مدير النظام والمدير والكاشير افتراضياً).
  العرض: + «obligations:view» (مراقب البيانات).
*/
const mongoose = require('mongoose');
const { wrapAll } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activity');
const { hasPermission } = require('../middlewares/permission');
const FixedObligation = require('../models/FixedObligation');
const ObligationCycle = require('../models/ObligationCycle');
const Expense = require('../models/Expense');
const S = require('../services/obligationService');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const bad = (res, message, code = 400, extra = {}) => res.status(code).json({ success: false, message, ...extra });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);

async function nextNumber() {
  const ExpenseSequence = require('../models/ExpenseSequence');
  for (let attempt = 1; ; attempt++) {
    try {
      const c = await ExpenseSequence.findOneAndUpdate({ _id: 'obligation' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
      return c.seq;
    } catch (err) {
      if (err && err.code === 11000 && attempt < 3) continue;
      throw err;
    }
  }
}

/** توقيع مدير النظام: المرسَل (ويُحفظ له للمرات القادمة) أو المحفوظ في حسابه. */
async function signatureOf(req) {
  const User = require('../models/User');
  const { validSignature } = require('./expenseController');
  const sent = String((req.body && req.body.signature) || '');
  if (sent) {
    if (!validSignature(sent)) throw Object.assign(new Error('صورة التوقيع غير صالحة'), { statusCode: 400 });
    await User.updateOne({ _id: req.user._id }, { $set: { signature: sent } });
    return sent;
  }
  const me = await User.findById(req.user._id).select('+signature').lean();
  return (me && me.signature) || '';
}

const caps = (u) => ({
  canManage: hasPermission(u, 'obligations:manage'),
  canPay: hasPermission(u, 'obligations:pay'),
  isAdmin: !!u && u.role === 'admin',
});

/* ═════════ القراءة ═════════ */

// GET /api/obligations?archived=1
const list = async (req, res) => {
  await S.sweep(); // التحديث الدوري (مرة كل دقيقة على الأكثر) — لا تظهر دورة انتهى موعدها مفتوحة
  const today = S.ymd();
  const archived = req.query.archived === '1' && req.user.role === 'admin';
  const obs = await FixedObligation.find({ archived: archived ? true : { $ne: true } }).sort({ active: -1, number: 1 }).lean();
  const items = [];
  for (const ob of obs) items.push(await S.summarize(ob, today));
  const open = items.filter((x) => x.cycle && x.cycle.status === 'open');
  const due = open.filter((x) => x.today && x.today.need > S.EPS);
  res.json({
    success: true,
    today,
    obligations: items,
    totals: {
      todayNeed: S.r3(due.reduce((t, x) => t + x.today.need, 0)),
      todayCount: due.length,
      remaining: S.r3(open.reduce((t, x) => t + x.cycle.remaining, 0)),
      missed: open.filter((x) => x.cycle.missedDays > 0).length,
    },
    ...caps(req.user),
  });
};

// GET /api/obligations/:id — الدورة الحالية يوماً بيوم، وسنداتها، والدورات السابقة
const getOne = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const ob = await FixedObligation.findById(req.params.id).lean();
  if (!ob || (ob.archived && req.user.role !== 'admin')) return bad(res, 'الالتزام غير موجود', 404);
  const today = S.ymd();
  const summary = await S.summarize(ob, today);
  let days = [];
  let payments = [];
  if (summary.cycle) {
    const cycle = await ObligationCycle.findById(summary.cycle._id).lean();
    payments = await Expense.find({ obligationCycle: cycle._id }).select('-approvedSignature').sort({ createdAt: 1 }).lean();
    days = S.plan(cycle, payments.filter((p) => !p.voided), today).days;
  }
  const cycles = await ObligationCycle.find({ obligation: ob._id }).sort({ seq: -1 }).limit(12).lean();
  res.json({ success: true, today, obligation: summary, days, payments, cycles, hasSignature: !!(await FixedObligation.findById(ob._id).select('+approvedSignature').lean()).approvedSignature, ...caps(req.user) });
};

/* ═════════ الإنشاء والتعديل ═════════ */

function readFields(b, { partial = false } = {}) {
  const out = {};
  const str = (k, max) => { if (b[k] != null) out[k] = String(b[k]).trim().slice(0, max); };
  str('name', 120); str('payee', 80); str('phone', 20); str('notes', 300);
  if (!partial || b.amount != null) out.amount = S.r3(b.amount);
  if (!partial || b.recurrence != null) out.recurrence = b.recurrence === 'once' ? 'once' : 'monthly';
  return out;
}

// POST /api/obligations { name, payee, phone, notes, amount, recurrence, dueDate, startDate?, signature? }
const create = async (req, res) => {
  const b = req.body || {};
  const f = readFields(b);
  if (!f.name) return bad(res, 'اكتب اسم الالتزام (مثل: إيجار المحل)');
  if (!f.payee) return bad(res, 'لمن يُدفع؟ (المؤجّر، الشركة…) — يصبح اسم المورّد إن صُدِّر المتبقي للذمم');
  if (!(f.amount > 0) || f.amount > 1000000) return bad(res, 'المبلغ يجب أن يكون أكبر من صفر');
  const today = S.ymd();
  const due = String(b.dueDate || '');
  if (!S.isYmd(due)) return bad(res, 'اختر موعد السداد');
  if (due < today) return bad(res, 'موعد السداد لا يكون في الماضي');
  if (S.diffDays(today, due) > 400) return bad(res, 'موعد السداد بعيد جداً (أكثر من سنة)');
  const start = S.isYmd(b.startDate) ? String(b.startDate) : today;
  if (start > due) return bad(res, 'بداية التقسيط بعد موعد السداد');
  if (S.diffDays(start, today) > 31) return bad(res, 'بداية التقسيط أقدم من شهر');

  const signature = await signatureOf(req);
  if (!signature) return bad(res, 'وقّع على الالتزام أولاً — توقيع مدير النظام يُطبع على كل سند يومي', 400, { code: 'SIGNATURE_REQUIRED' });

  const ob = await FixedObligation.create({
    number: await nextNumber(),
    ...f,
    dueDay: Number(due.slice(8, 10)),
    approvedBy: req.user._id, approvedByName: nameOf(req.user), approvedAt: new Date(), approvedSignature: signature,
    brand: b.brand || 'diyar',
    createdBy: req.user._id, createdByName: nameOf(req.user),
  });
  await S.createCycle(ob, 1, start, due, ob.amount);
  logActivity({ req, action: 'obligation.create', amount: ob.amount, details: { name: ob.name, number: ob.number, payee: ob.payee, due: S.AR_DATE(due), recurrence: ob.recurrence === 'once' ? 'مرة واحدة' : 'شهري' } });
  res.status(201).json({ success: true, obligation: await S.summarize(ob.toObject()) });
};

// PUT /api/obligations/:id { name, payee, phone, notes, amount, recurrence, dueDate }
// المبلغ والموعد الجديدان يسريان على الدورة الحالية أيضاً (والقسط يُعاد حسابه فوراً)
const update = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const ob = await FixedObligation.findById(req.params.id).lean();
  if (!ob || ob.archived) return bad(res, 'الالتزام غير موجود', 404);
  const b = req.body || {};
  const f = readFields(b, { partial: true });
  if ('name' in f && !f.name) return bad(res, 'اسم الالتزام مطلوب');
  if ('payee' in f && !f.payee) return bad(res, 'لمن يُدفع؟');
  if ('amount' in f && (!(f.amount > 0) || f.amount > 1000000)) return bad(res, 'المبلغ يجب أن يكون أكبر من صفر');

  const today = S.ymd();
  const cycle = await S.sync(ob, today);
  const open = cycle && cycle.status === 'open' ? cycle : null;
  const cycleSet = {};
  if ('amount' in f && open && Math.abs(f.amount - open.amount) > S.EPS) {
    if (f.amount + S.EPS < open.paid) return bad(res, `دُفع من الدورة الحالية ${open.paid.toFixed(3)} — المبلغ الجديد لا يكون أقل منه`);
    cycleSet.amount = f.amount;
  }
  if (b.dueDate != null && b.dueDate !== '') {
    const due = String(b.dueDate);
    if (!S.isYmd(due)) return bad(res, 'موعد سداد غير صالح');
    if (open) {
      if (due < today) return bad(res, 'الموعد الجديد لا يكون في الماضي');
      if (due < open.startDay) return bad(res, 'الموعد قبل بداية الدورة');
      if (S.diffDays(today, due) > 400) return bad(res, 'موعد السداد بعيد جداً');
      cycleSet.dueDay = due;
    }
    f.dueDay = Number(due.slice(8, 10));
  }
  await FixedObligation.updateOne({ _id: ob._id }, { $set: f });
  if (open && Object.keys(cycleSet).length) await ObligationCycle.updateOne({ _id: open._id, status: 'open' }, { $set: cycleSet });
  logActivity({ req, action: 'obligation.update', amount: f.amount != null ? f.amount : ob.amount, details: { name: f.name || ob.name, number: ob.number, ...(cycleSet.dueDay ? { due: S.AR_DATE(cycleSet.dueDay) } : {}) } });
  res.json({ success: true, obligation: await S.summarize(await FixedObligation.findById(ob._id).lean()) });
};

// POST /api/obligations/:id/sign { signature } — توقيع جديد لمدير النظام على السندات القادمة
const sign = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const signature = await signatureOf(req);
  if (!signature) return bad(res, 'وقّع أولاً', 400, { code: 'SIGNATURE_REQUIRED' });
  const r = await FixedObligation.updateOne({ _id: req.params.id, archived: { $ne: true } },
    { $set: { approvedBy: req.user._id, approvedByName: nameOf(req.user), approvedAt: new Date(), approvedSignature: signature } });
  if (!r.matchedCount) return bad(res, 'الالتزام غير موجود', 404);
  logActivity({ req, action: 'obligation.sign', details: { id: req.params.id } });
  res.json({ success: true });
};

// POST /api/obligations/:id/stop — لا دورات بعد الحالية (الحالية تكمل حتى موعدها)
const stop = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const ob = await FixedObligation.findOneAndUpdate({ _id: req.params.id, archived: { $ne: true } }, { $set: { active: false } }, { new: true }).lean();
  if (!ob) return bad(res, 'الالتزام غير موجود', 404);
  logActivity({ req, action: 'obligation.stop', details: { name: ob.name, number: ob.number } });
  res.json({ success: true, obligation: await S.summarize(ob) });
};

// POST /api/obligations/:id/resume — يعود التقسيط: من اليوم حتى أقرب موعد (إن لم تكن دورة مفتوحة)
const resume = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const ob = await FixedObligation.findOne({ _id: req.params.id, archived: { $ne: true } }).lean();
  if (!ob) return bad(res, 'الالتزام غير موجود', 404);
  const today = S.ymd();
  const last = await S.sync(ob, today);
  if (!(last && last.status === 'open')) {
    if (ob.recurrence === 'once' && last) return bad(res, 'التزام لمرة واحدة انتهت دورته — أنشئ التزاماً جديداً');
    await S.createCycle(ob, last ? last.seq + 1 : 1, today, S.upcomingDue(today, ob.dueDay), ob.amount);
  }
  await FixedObligation.updateOne({ _id: ob._id }, { $set: { active: true } });
  logActivity({ req, action: 'obligation.resume', details: { name: ob.name, number: ob.number } });
  res.json({ success: true, obligation: await S.summarize(await FixedObligation.findById(ob._id).lean()) });
};

// DELETE /api/obligations/:id — أرشفة (لا حذف) لمدير النظام وحده
const archive = async (req, res) => {
  if (req.user.role !== 'admin') return bad(res, 'أرشفة الالتزامات لمدير النظام فقط', 403);
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const ob = await FixedObligation.findOne({ _id: req.params.id, archived: { $ne: true } }).lean();
  if (!ob) return bad(res, 'الالتزام غير موجود', 404);
  const cur = await S.sync(ob, S.ymd());
  if (cur && cur.status === 'open') {
    const remaining = S.r3(cur.amount - cur.paid);
    if (cur.paid > S.EPS && remaining > S.EPS) {
      return bad(res, `دُفع من الدورة الحالية ${cur.paid.toFixed(3)} وبقي ${remaining.toFixed(3)} — أوقفه بدل الأرشفة، فتُكمل الدورة حتى موعدها (ويُصدَّر المتبقي للذمم)`);
    }
    await ObligationCycle.updateOne({ _id: cur._id, status: 'open' }, { $set: { status: 'closed', closedAt: new Date(), outcome: cur.paid > S.EPS ? 'settled' : 'cancelled' } });
  }
  await FixedObligation.updateOne({ _id: ob._id }, { $set: { archived: true, active: false, archivedAt: new Date(), archivedByName: nameOf(req.user) } });
  logActivity({ req, action: 'obligation.archive', amount: ob.amount, details: { name: ob.name, number: ob.number } });
  res.json({ success: true });
};

/* ═════════ دفع قسط اليوم ═════════ */

// POST /api/obligations/:id/pay { amount?, source: drawer|capital }
const pay = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const ob = await FixedObligation.findOne({ _id: req.params.id, archived: { $ne: true } }).select('+approvedSignature').lean();
  if (!ob) return bad(res, 'الالتزام غير موجود', 404);
  const b = req.body || {};
  const source = b.source === 'capital' ? 'capital' : 'drawer';
  if (source === 'capital' && !hasPermission(req.user, 'capital:manage')) return bad(res, 'الدفع من رأس المال يحتاج صلاحية «رأس المال»', 403);
  if (!ob.approvedSignature) return bad(res, 'الالتزام بلا توقيع مدير النظام — يوقّعه أولاً من «الالتزامات الثابتة»', 400, { code: 'SIGNATURE_MISSING' });

  const today = S.ymd();
  let done = null;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    const cycle = await S.sync(ob, today);
    if (!cycle || cycle.status !== 'open') return bad(res, 'لا دورة مفتوحة لهذا الالتزام');
    if (cycle.startDay > today) return bad(res, `يبدأ تقسيط هذه الدورة يوم ${S.AR_DATE(cycle.startDay)}`);
    const p = S.plan(cycle, await S.cyclePayments(cycle._id), today);
    const remaining = S.r3(cycle.amount - cycle.paid);
    if (remaining <= S.EPS) return bad(res, 'سُدّد مبلغ هذه الدورة كاملاً ✓');
    const amount = b.amount != null && b.amount !== '' ? S.r3(b.amount) : p.today.need;
    if (!(amount > 0)) return bad(res, 'قسط اليوم مدفوع ✓ — لدفع مبلغ إضافي اكتب المبلغ');
    if (amount > remaining + S.EPS) return bad(res, `المتبقي من الدورة ${remaining.toFixed(3)} فقط`);

    if (source === 'capital') {
      const CapitalEntry = require('../models/CapitalEntry');
      const all = await CapitalEntry.find({ voided: { $ne: true } }).select('type amount').lean();
      const balance = all.reduce((t, e) => t + CapitalEntry.signed(e), 0);
      if (amount > balance + 1e-9) return bad(res, `رصيد رأس المال (${balance.toFixed(3)}) لا يكفي`);
    }

    // حجز ذرّي (مقارنة وتبديل): دفعتان متزامنتان لا تتجاوزان مبلغ الدورة
    const after = S.r3(cycle.paid + amount);
    const held = await ObligationCycle.findOneAndUpdate(
      { _id: cycle._id, status: 'open', paid: cycle.paid },
      { $set: { paid: after }, $inc: { payments: 1 } },
      { new: true }
    ).lean();
    if (!held) continue; // دُفع شيء في اللحظة نفسها: نعيد الحساب
    done = { cycle: held, amount, remainingAfter: S.r3(held.amount - after), plan: p };
  }
  if (!done) return bad(res, 'دُفع قسط في اللحظة نفسها من جهاز آخر — حدّث وحاول مجدداً', 409);

  const { cycle, amount, remainingAfter } = done;
  const daysLeftAfter = Math.max(0, S.diffDays(today, cycle.dueDay));
  let expense;
  try {
    expense = await Expense.create({
      number: await require('./expenseController').nextExpenseNumber(),
      name: `قسط يومي: ${ob.name}`.slice(0, 120),
      amount,
      paidTo: ob.payee,
      source,
      spentAt: new Date(),
      kind: 'general',
      approvedByName: ob.approvedByName, approvedByRole: 'admin', approvedAt: ob.approvedAt, approvedSignature: ob.approvedSignature,
      obligation: ob._id, obligationCycle: cycle._id, obligationNumber: ob.number, obligationDay: today,
      obligationDue: cycle.dueDay, obligationAmount: cycle.amount, obligationRemaining: remainingAfter, obligationDaysLeft: daysLeftAfter,
      brand: ob.brand || 'diyar',
      createdBy: req.user._id, createdByName: nameOf(req.user),
    });
  } catch (err) {
    await ObligationCycle.updateOne({ _id: cycle._id }, { $inc: { paid: -amount, payments: -1 } }); // لم يُسجَّل السند: يعود المبلغ
    throw err;
  }
  if (source === 'capital') {
    await require('../models/CapitalEntry').create({
      type: 'expense', amount, note: expense.name, date: expense.spentAt, expense: expense._id, expenseNumber: expense.number,
      createdBy: req.user._id, createdByName: nameOf(req.user),
    });
  }
  logActivity({ req, action: 'obligation.pay', amount, details: { name: ob.name, number: ob.number, voucher: expense.number, remaining: remainingAfter, daysLeft: daysLeftAfter, source: source === 'capital' ? 'رأس المال' : 'الصندوق' } });
  try { require('../services/liveReportService').touch(); } catch (_) { /* */ }
  console.log(`📆 قسط التزام #${ob.number} «${ob.name}» ${amount.toFixed(3)} — سند #${expense.number} بواسطة ${req.user.username}`);
  res.status(201).json({ success: true, expense: expense.toObject(), obligation: await S.summarize(await FixedObligation.findById(ob._id).lean(), today) });
};

module.exports = wrapAll({ list, getOne, create, update, sign, stop, resume, archive, pay });
