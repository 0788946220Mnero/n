/*
  ═══════════════════════════════════════════════════════════════
  الالتزامات الثابتة — إيجار، اشتراك، قسط… مبلغ بموعد سداد يُقسَّم يومياً.

  • قسط اليوم = المتبقي من الدورة ÷ الأيام المتبقية حتى الموعد (شاملاً اليوم).
    يوم لم يُدفع ← يبقى مبلغه في المتبقي فيُوزَّع على الأيام الباقية (يزيد القسط تلقائياً).
    آخر يوم = كل المتبقي.
  • الدفع = سند صرف حقيقي (من صندوق الدافع فيدخل جرده، أو من رأس المال) برقم السندات
    التسلسلي، وعليه ختم «مدفوع» وتوقيع مدير النظام الذي اعتمد الالتزام.
  • بعد موعد السداد: سُدّدت كاملة ← تُغلق، وإلا ← إشعار «لم يُسدَّد» ويُصدَّر المتبقي
    فاتورةً غير مدفوعة في «ذمم الموردين» باسم المستفيد. ثم تبدأ دورة الشهر التالي (للمتكرر).
  • يوم فات بلا دفع ← إشعار صباح اليوم التالي بالقسط الجديد.

  الأيام كلها بتوقيت عمّان (YYYY-MM-DD). الساعة قابلة للاستبدال في الاختبارات (svc.clock).
  ═══════════════════════════════════════════════════════════════
*/
const FixedObligation = require('../models/FixedObligation');
const ObligationCycle = require('../models/ObligationCycle');
const Expense = require('../models/Expense');

const TZ = 'Asia/Amman';
const svc = { clock: () => new Date() };

/* ═════════ أدوات الأيام والمبالغ ═════════ */

const r3 = (n) => Number(Number(n || 0).toFixed(3));
const EPS = 0.0005;
/** للأعلى لأقرب فلس: مجموع الأقساط لا ينقص عن المبلغ، وآخر يوم يأخذ الباقي بالضبط. */
const ceil3 = (n) => Math.ceil(Number(n) * 1000 - 1e-6) / 1000;
const m3 = (n) => Number(n || 0).toFixed(3);

function ymd(d = svc.clock()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}`;
}
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(`${s}T00:00:00Z`));
const toUtc = (s) => Date.parse(`${s}T00:00:00Z`);
const addDays = (s, n) => new Date(toUtc(s) + n * 86400000).toISOString().slice(0, 10);
/** عدد الأيام من a إلى b (b − a). */
const diffDays = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12
/** موعد الشهر التالي ليوم الاستحقاق (31 ← آخر الشهر إن كان أقصر). */
function nextDue(prevDue, dueDay) {
  let [y, m] = prevDue.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  const d = Math.min(dueDay, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** أقرب موعد ليوم الاستحقاق من اليوم فصاعداً. */
function upcomingDue(today, dueDay) {
  const [y, m] = today.split('-').map(Number);
  const d = Math.min(dueDay, daysInMonth(y, m));
  const here = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return here >= today ? here : nextDue(here, dueDay);
}
const AR_DATE = (s) => (s ? s.split('-').reverse().join('/') : '');

/* ═════════ خطة الدورة يوماً بيوم ═════════ */

/**
 * يحسب كل يوم في الدورة: المطلوب فيه (حسب ما بقي في بدايته)، وما دُفع فيه، وحالته.
 *   paid ← مدفوع | partial ← جزئي | missed ← فات بلا دفع | due ← اليوم ولم يكتمل
 *   upcoming ← قادم (تقدير: لو دُفع كل يوم قسطه) | done ← لا شيء مطلوب (اكتمل المبلغ)
 * @param {object} cycle
 * @param {Array<{obligationDay:string, amount:number}>} payments سندات الدورة غير الملغاة
 */
function plan(cycle, payments, today = ymd()) {
  const byDay = {};
  (payments || []).forEach((p) => { byDay[p.obligationDay] = r3((byDay[p.obligationDay] || 0) + Number(p.amount || 0)); });
  const days = [];
  let rem = r3(cycle.amount);
  let todayInfo = null;
  const total = diffDays(cycle.startDay, cycle.dueDay) + 1;
  for (let i = 0; i < total; i++) {
    const day = addDays(cycle.startDay, i);
    const left = total - i; // الأيام المتبقية شاملة هذا اليوم
    const need = rem <= EPS ? 0 : left === 1 ? r3(rem) : Math.min(r3(rem), ceil3(rem / left));
    const paid = byDay[day] || 0;
    let status;
    if (day < today) status = need <= EPS ? (paid > 0 ? 'paid' : 'done') : paid + EPS >= need ? 'paid' : paid > 0 ? 'partial' : 'missed';
    else if (day === today) status = need <= EPS ? (paid > 0 ? 'paid' : 'done') : paid + EPS >= need ? 'paid' : paid > 0 ? 'partial' : 'due';
    else status = need <= EPS ? 'done' : 'upcoming';
    days.push({ day, need, paid, status, left });
    if (day === today) {
      todayInfo = { day, base: need, paid, need: r3(Math.max(0, need - paid)), daysLeft: left, remainingAtStart: rem };
    }
    // القادم: نفترض دفع قسطه (وقسط اليوم) كاملاً — تقدير لعرض الأقساط القادمة
    rem = r3(rem - (day > today ? need : day === today ? Math.max(paid, need) : paid));
  }
  const paidTotal = r3(Object.values(byDay).reduce((t, v) => t + v, 0));
  return {
    days,
    today: todayInfo,
    paid: paidTotal,
    remaining: r3(Math.max(0, cycle.amount - paidTotal)),
    missedDays: days.filter((d) => d.status === 'missed').length,
  };
}

const cyclePayments = (cycleId) => Expense.find({ obligationCycle: cycleId, voided: { $ne: true } })
  .select('number amount obligationDay createdByName createdAt source spentAt').sort({ createdAt: 1 }).lean();

/* ═════════ الدورات: الإنشاء والإغلاق والتصدير ═════════ */

async function nextReceivableNumber() {
  const ExpenseSequence = require('../models/ExpenseSequence');
  for (let attempt = 1; ; attempt++) {
    try {
      const c = await ExpenseSequence.findOneAndUpdate({ _id: 'receivable' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
      return c.seq;
    } catch (err) {
      if (err && err.code === 11000 && attempt < 3) continue;
      throw err;
    }
  }
}

/**
 * انتهى موعد الدورة: تُغلق ذرّياً (مرة واحدة حتى مع مهمتين متزامنتين).
 * المتبقي > 0 ← فاتورة غير مدفوعة في «ذمم الموردين» + إشعار.
 */
async function closeCycle(cycle, ob) {
  const closed = await ObligationCycle.findOneAndUpdate(
    { _id: cycle._id, status: 'open' },
    { $set: { status: 'closed', closedAt: svc.clock() } },
    { new: true }
  ).lean();
  if (!closed) return null;
  const remaining = r3(closed.amount - closed.paid);
  if (remaining <= EPS) {
    await ObligationCycle.updateOne({ _id: closed._id }, { $set: { outcome: 'settled' } });
    return { ...closed, outcome: 'settled' };
  }
  try {
    const Receivable = require('../models/Receivable');
    const rec = await Receivable.create({
      number: await nextReceivableNumber(),
      customerName: ob.payee,
      phone: ob.phone || '',
      lines: [{ name: `${ob.name} — المتبقي حتى ${AR_DATE(closed.dueDay)}`.slice(0, 120), quantity: 1, price: remaining }],
      amount: remaining,
      notes: `التزام ثابت #${ob.number}: مبلغ الدورة ${m3(closed.amount)}، دُفع منه ${m3(closed.paid)} على أقساط يومية (${AR_DATE(closed.startDay)}–${AR_DATE(closed.dueDay)})، والمتبقي لم يُسدَّد حتى موعده`.slice(0, 300),
      invoiceNumber: `التزام-${ob.number}-${closed.seq}`.slice(0, 40),
      obligation: ob._id,
      obligationCycle: closed._id,
      createdBy: ob.approvedBy || ob.createdBy,
      createdByName: 'الالتزامات الثابتة',
    });
    await ObligationCycle.updateOne({ _id: closed._id }, { $set: { outcome: 'exported', exportedAmount: remaining, receivable: rec._id, receivableNumber: rec.number } });
    require('../utils/activity').logActivity({ user: { _id: null, name: 'النظام', role: '' }, action: 'obligation.export', amount: remaining, details: { name: ob.name, number: ob.number, receivable: rec.number, payee: ob.payee } });
    require('./staffAlertService').emit('obligation.exported', { userName: 'النظام', amount: remaining, details: { name: ob.name, payee: ob.payee, receivable: rec.number, due: AR_DATE(closed.dueDay), paid: closed.paid, total: closed.amount } });
    console.log(`📌 التزام #${ob.number} «${ob.name}»: صُدِّر المتبقي ${m3(remaining)} لذمم الموردين (#${rec.number})`);
    return { ...closed, outcome: 'exported', receivableNumber: rec.number, exportedAmount: remaining };
  } catch (err) {
    // لم تُنشأ الفاتورة: تعود الدورة مفتوحة لتُعاد المحاولة في الجولة القادمة (لا تضيع المديونية)
    await ObligationCycle.updateOne({ _id: closed._id }, { $set: { status: 'open', closedAt: null } });
    throw err;
  }
}

async function createCycle(ob, seq, startDay, dueDay, amount) {
  try {
    return (await ObligationCycle.create({ obligation: ob._id, seq, startDay, dueDay, amount: r3(amount) })).toObject();
  } catch (err) {
    if (err && err.code === 11000) return ObligationCycle.findOne({ obligation: ob._id, seq }).lean(); // أنشأتها جولة متزامنة
    throw err;
  }
}

/**
 * يجعل دورات الالتزام مطابقة لليوم: يُغلق ما انتهى موعده (ويصدّر)، ويفتح دورة الشهر التالي.
 * يرجع الدورة الحالية (المفتوحة) أو آخر دورة.
 */
async function sync(ob, today = ymd()) {
  let last = await ObligationCycle.findOne({ obligation: ob._id }).sort({ seq: -1 }).lean();
  for (let guard = 0; guard < 36; guard++) {
    if (!last) return null;
    if (last.status === 'open') {
      if (today <= last.dueDay) return last;
      const closed = await closeCycle(last, ob);
      last = closed || await ObligationCycle.findById(last._id).lean();
      continue;
    }
    // مغلقة: المتكرر النشط تبدأ دورته التالية من اليوم التالي للموعد
    if (!(ob.active && !ob.archived && ob.recurrence === 'monthly')) return last;
    const start = addDays(last.dueDay, 1);
    if (start > today) return last; // (لا يحدث عادةً) الدورة القادمة لم تبدأ
    last = await createCycle(ob, last.seq + 1, start, nextDue(last.dueDay, ob.dueDay), ob.amount);
  }
  return last;
}

/** تنبيه «لم يُدفع قسط أمس» — مرة واحدة لكل يوم. */
async function notifyMissed(ob, cycle, today = ymd()) {
  const yesterday = addDays(today, -1);
  if (cycle.status !== 'open' || yesterday < cycle.startDay || today > cycle.dueDay) return false;
  const payments = await cyclePayments(cycle._id);
  const p = plan(cycle, payments, today);
  const y = p.days.find((d) => d.day === yesterday);
  if (!y || !['missed', 'partial'].includes(y.status)) return false;
  const marked = await ObligationCycle.findOneAndUpdate(
    { _id: cycle._id, missedNotified: { $ne: yesterday } },
    { $push: { missedNotified: yesterday } },
    { new: true }
  ).lean();
  if (!marked) return false;
  const t = p.today || { need: 0, daysLeft: 0 };
  require('./staffAlertService').emit('obligation.missed', {
    userName: 'النظام', amount: t.need,
    details: { name: ob.name, missed: r3(y.need - y.paid), need: t.need, remaining: p.remaining, daysLeft: t.daysLeft, due: AR_DATE(cycle.dueDay), lastDay: t.daysLeft === 1 },
  });
  return true;
}

let lastSweep = 0;
let sweeping = null;
/** جولة على كل الالتزامات: إغلاق ما انتهى وتصديره، فتح الدورات الجديدة، تنبيهات الأيام الفائتة. */
async function sweep({ force = false } = {}) {
  if (!force && Date.now() - lastSweep < 60000) return sweeping || null;
  if (sweeping) return sweeping;
  lastSweep = Date.now();
  sweeping = (async () => {
    const today = ymd();
    const obs = await FixedObligation.find({ archived: { $ne: true } }).lean();
    for (const ob of obs) {
      try {
        const cur = await sync(ob, today);
        if (cur && cur.status === 'open') await notifyMissed(ob, cur, today);
      } catch (e) { console.error('obligation sweep:', ob.number, e.message); }
    }
  })().finally(() => { sweeping = null; });
  return sweeping;
}

let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => sweep({ force: true }).catch((e) => console.error('obligations:', e.message)), 20000).unref?.();
  timer = setInterval(() => sweep({ force: true }).catch((e) => console.error('obligations:', e.message)), 15 * 60000);
  if (timer.unref) timer.unref();
}

/* ═════════ ملخص للعرض ═════════ */

async function summarize(ob, today = ymd()) {
  const cycle = await sync(ob, today);
  if (!cycle) return { ...ob, cycle: null };
  const payments = await cyclePayments(cycle._id);
  const p = plan(cycle, payments, today);
  const started = cycle.startDay <= today;
  return {
    ...ob,
    approvedSignature: undefined,
    cycle: {
      _id: cycle._id, seq: cycle.seq, startDay: cycle.startDay, dueDay: cycle.dueDay, amount: cycle.amount,
      status: cycle.status, outcome: cycle.outcome, receivableNumber: cycle.receivableNumber, exportedAmount: cycle.exportedAmount,
      paid: p.paid, remaining: p.remaining, missedDays: p.missedDays, daysTotal: p.days.length,
      daysLeft: cycle.status === 'open' && started ? diffDays(today, cycle.dueDay) + 1 : cycle.status === 'open' ? p.days.length : 0,
      started,
    },
    today: cycle.status === 'open' && p.today ? p.today : null,
  };
}

module.exports = {
  svc, ymd, isYmd, addDays, diffDays, nextDue, upcomingDue, plan, sync, sweep, start, summarize, closeCycle, createCycle,
  notifyMissed, cyclePayments, r3, ceil3, EPS, AR_DATE,
  _reset: () => { lastSweep = 0; sweeping = null; },
};
