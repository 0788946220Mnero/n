/**
 * تكلفة العمالة من الدوام الفعلي (AttendanceShift):
 *   الدقائق المدفوعة = (الخروج − الدخول) − الاستراحات      (الدوام المفتوح يُحسب حتى الآن ← «تقديري»)
 *   أجر الساعة      = hourlyRate للموظف إن وُجد،
 *                     وإلا الراتب الشهري ÷ (أيام العمل في الشهر × ساعات دوامه)     ← «موزّع»
 *   الإضافي          = ما زاد على ساعات دوامه × معامل الإضافي (1.25 افتراضياً)
 *   التوزيع على أيام العمل بنسبة تداخل الدوام مع كل يوم — فالدوام الممتد بعد منتصف الليل
 *   يُقسَّم حسب حدود يوم العمل (06:00 افتراضياً) لا حسب منتصف الليل.
 */
const AttendanceShift = require('../../models/AttendanceShift');
const Employee = require('../../models/Employee');
const { dayRange } = require('./time');

const r3 = (n) => Math.round(n * 1000) / 1000;

function rateOf(emp, cfg) {
  if (emp.hourlyRate > 0) return { rate: emp.hourlyRate, basis: 'actual', how: `أجر ساعة محدد ${emp.hourlyRate}` };
  if (emp.salary > 0) {
    const hrs = emp.shiftHours > 0 ? emp.shiftHours : cfg.defaultShiftHours;
    const rate = emp.salary / (cfg.workDaysPerMonth * hrs);
    return { rate, basis: 'allocated', how: `${emp.salary} ÷ (${cfg.workDaysPerMonth} يوم × ${hrs} س)` };
  }
  return { rate: 0, basis: 'missing', how: 'لا راتب ولا أجر ساعة' };
}

function breakMinutes(sh, until) {
  return (sh.breaks || []).reduce((s, b) => {
    if (b.minutes > 0 && b.endAt) return s + b.minutes;
    const st = new Date(b.startAt).getTime(); const en = b.endAt ? new Date(b.endAt).getTime() : until;
    return s + Math.max(0, (en - st) / 60000);
  }, 0);
}

/**
 * @param {string[]} days أيام العمل
 * @returns {{byDay: Map<day,{cost,minutes}>, rows: [], missing: string[]}}
 */
async function laborForDays(days, cfg, now = new Date()) {
  const byDay = new Map(days.map((d) => [d, { cost: 0, minutes: 0, estimated: false }]));
  if (!days.length) return { byDay, rows: [], missing: [] };
  const ranges = days.map((d) => ({ d, ...dayRange(d, cfg.dayStartHour) }));
  const start = ranges[0].start; const end = ranges[ranges.length - 1].end;
  const shifts = await AttendanceShift.find({ clockInAt: { $lt: end }, dayType: { $ne: 'off' } }).lean();
  const relevant = shifts.filter((s) => !s.clockOutAt || new Date(s.clockOutAt) > start);
  const emps = new Map((await Employee.find({ _id: { $in: relevant.map((s) => s.employee) } }).lean()).map((e) => [String(e._id), e]));
  const rows = new Map(); const missing = new Set();
  for (const sh of relevant) {
    const emp = emps.get(String(sh.employee)) || { name: sh.employeeName, salary: 0 };
    const inT = new Date(sh.clockInAt).getTime();
    const outT = sh.clockOutAt ? new Date(sh.clockOutAt).getTime() : Math.min(now.getTime(), end.getTime());
    const span = Math.max(0, (outT - inT) / 60000);
    if (!span) continue;
    const worked = Math.max(0, span - breakMinutes(sh, outT));
    const { rate, basis, how } = rateOf(emp, cfg);
    if (basis === 'missing') missing.add(emp.name || sh.employeeName);
    const sched = (emp.shiftHours > 0 ? emp.shiftHours : cfg.defaultShiftHours) * 60;
    const ot = Math.max(0, worked - sched);
    const shiftCost = ((worked - ot) + ot * cfg.overtimeMultiplier) * rate / 60;
    const k = String(sh.employee);
    if (!rows.has(k)) rows.set(k, { employee: sh.employee, name: emp.name || sh.employeeName, section: sh.section || emp.section || '', minutes: 0, overtimeMinutes: 0, rate: r3(rate), how, basis, cost: 0, open: false, shifts: 0 });
    const row = rows.get(k);
    for (const r of ranges) {
      const ov = Math.max(0, (Math.min(outT, r.end.getTime()) - Math.max(inT, r.start.getTime())) / 60000);
      if (!ov) continue;
      const frac = ov / span;
      const b = byDay.get(r.d); b.cost += shiftCost * frac; b.minutes += worked * frac; if (!sh.clockOutAt) b.estimated = true;
      row.minutes += worked * frac; row.overtimeMinutes += ot * frac; row.cost += shiftCost * frac;
    }
    row.shifts += 1; if (!sh.clockOutAt) row.open = true;
  }
  return {
    byDay,
    rows: [...rows.values()].map((r) => ({ ...r, minutes: Math.round(r.minutes), overtimeMinutes: Math.round(r.overtimeMinutes), cost: r3(r.cost), basis: r.open ? 'estimated' : r.basis })).sort((a, b) => b.cost - a.cost),
    missing: [...missing],
  };
}

module.exports = { laborForDays, rateOf };
