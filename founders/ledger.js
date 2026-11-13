/*
  حساب الأقساط — مصدر الحقيقة لكل رقم يظهر في اللوحة وواجهة المؤسسين.

  القاعدة: القسط الشهري ثابت. ما فات من أقساط يتراكم «بالجملة» كمتأخرات،
  ولا يُوزَّع على الأقساط القادمة (لا يزيد قسط الشهر التالي، ولا يزيد إجمالي الدين).

    المستحق حتى الآن = min(الإجمالي، عدد الأشهر من البداية حتى هذا الشهر × القسط)
    المدفوع          = مجموع الدفعات المختومة فقط
    قيد المراجعة     = دفعات بانتظار ختم مدير النظام (تُحجز فلا يُدفع فوقها)
    المتأخر المتراكم = المستحق حتى الآن − المدفوع − قيد المراجعة (لا يقل عن صفر)
    المتبقي          = الإجمالي − المدفوع
*/
const EPS = 0.0005;
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

const svc = { clock: () => new Date() };

/** الشهر الحالي بتوقيت عمّان YYYY-MM. */
function monthNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit' }).formatToParts(svc.clock());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}`;
}
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const monthLabel = (m) => (isMonth(m) ? `${AR_MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');

/** عدد الأقساط الكلي (آخر قسط = الباقي). */
const installmentsCount = (debt) => Math.max(1, Math.ceil((debt.totalAmount - EPS) / debt.monthlyInstallment));

/**
 * ملخص دين من الدفعات (كل الدفعات بحالاتها — المرفوضة لا تُحسب).
 * الدفعة المربوطة بقسط (installmentMonth) تُحسب على قسطها — ولو جزءاً منه.
 * الدفعة العامة (بلا قسط) تُوزَّع على الأقساط المفتوحة من الأقدم (FIFO).
 * @param {object} debt
 * @param {Array<{amount,status,installmentMonth}>} payments
 */
function summarize(debt, payments, now = monthNow()) {
  const total = r3(debt.totalAmount);
  const monthly = r3(debt.monthlyInstallment);
  const count = installmentsCount(debt);
  const elapsed = Math.max(0, Math.min(count, monthIndex(now) - monthIndex(debt.startMonth) + 1));
  const dueToDate = r3(Math.min(total, elapsed * monthly));
  const paid = r3(payments.filter((p) => p.status === 'stamped').reduce((t, p) => t + p.amount, 0));
  const pending = r3(payments.filter((p) => p.status === 'review').reduce((t, p) => t + p.amount, 0));
  const remaining = r3(Math.max(0, total - paid));
  const payable = r3(Math.max(0, total - paid - pending)); // الحد الأعلى لدفعة جديدة عامة

  // 1) الأقساط
  const start = monthIndex(debt.startMonth);
  const rows = [];
  const byMonth = new Map();
  for (let i = 0; i < count; i++) {
    const m = monthOf(start + i);
    const row = { month: m, label: monthLabel(m), amount: r3(i === count - 1 ? total - monthly * (count - 1) : monthly), covered: 0, inReview: 0, parts: 0 };
    rows.push(row); byMonth.set(m, row);
  }
  // 2) الدفعات المربوطة بقسط: على قسطها
  let freeStamped = 0; let freeReview = 0;
  for (const p of payments) {
    if (p.status !== 'stamped' && p.status !== 'review') continue;
    const row = p.installmentMonth ? byMonth.get(p.installmentMonth) : null;
    if (!row) { if (p.status === 'stamped') freeStamped += p.amount; else freeReview += p.amount; continue; }
    if (p.status === 'stamped') row.covered = r3(row.covered + p.amount); else row.inReview = r3(row.inReview + p.amount);
    row.parts += 1;
  }
  // 3) الدفعات العامة: على المفتوح من الأقدم
  const fill = (pool, key) => {
    for (const row of rows) {
      if (pool <= EPS) break;
      const gap = r3(row.amount - row.covered - row.inReview);
      if (gap <= EPS) continue;
      const take = r3(Math.min(gap, pool));
      row[key] = r3(row[key] + take); pool = r3(pool - take);
    }
  };
  fill(r3(freeStamped), 'covered');
  fill(r3(freeReview), 'inReview');

  // 4) الحالة والمفتوح لكل قسط، والمتأخر المتراكم = مجموع المفتوح من الأقساط المستحقة
  let arrears = 0; let overdueMonths = 0;
  const schedule = rows.map((row) => {
    const open = r3(Math.max(0, row.amount - row.covered - row.inReview));
    const isPast = monthIndex(row.month) <= monthIndex(now);
    let state;
    if (row.covered >= row.amount - EPS) state = 'paid';
    else if (open <= EPS) state = 'review';
    else if (row.covered > EPS || row.inReview > EPS) state = isPast ? 'partial' : 'partial-upcoming';
    else if (monthIndex(row.month) < monthIndex(now)) state = 'overdue';
    else if (row.month === now) state = 'due';
    else state = 'upcoming';
    if (isPast && open > EPS) { arrears = r3(arrears + open); overdueMonths += 1; }
    return { month: row.month, label: row.label, amount: row.amount, covered: row.covered, inReview: row.inReview, open, parts: row.parts, state };
  });
  const endMonth = monthOf(start + count - 1);
  const status = remaining <= EPS ? 'settled' : debt.status;

  return {
    _id: debt._id, number: debt.number, scope: debt.scope, owner: debt.owner, ownerName: debt.ownerName,
    title: debt.title, creditor: debt.creditor, notes: debt.notes,
    totalAmount: total, monthlyInstallment: monthly, startMonth: debt.startMonth, endMonth,
    startLabel: monthLabel(debt.startMonth), endLabel: monthLabel(endMonth),
    installments: count, elapsedInstallments: elapsed,
    dueToDate, paid, pending, remaining, arrears, payable, overdueMonths,
    // المطلوب الآن: المتأخر المتراكم (يشمل قسط هذا الشهر إن لم يُدفع) — بلا زيادة على ما بعده
    dueNow: arrears,
    progress: total > 0 ? Math.min(1, paid / total) : 0,
    status, rawStatus: debt.status, corrections: (debt.corrections || []).length,
    schedule, createdAt: debt.createdAt,
  };
}

module.exports = { EPS, r3, svc, monthNow, isMonth, monthIndex, monthOf, monthLabel, installmentsCount, summarize };
