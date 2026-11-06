/**
 * يوم العمل المالي بتوقيت عمّان: يبدأ من dayStartHour (افتراضياً 06:00) وينتهي قبله في اليوم التالي.
 * طلب الساعة 01:30 فجراً يتبع يوم العمل السابق — فالوردية الممتدة بعد منتصف الليل يوم واحد.
 */
const TZ = 'Asia/Amman';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function parts(d) {
  const o = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
/** فرق توقيت عمّان عن UTC بالمللي ثانية لتلك اللحظة. */
function offsetMs(d) {
  const p = parts(d);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
/** ساعة حائط في عمّان ← لحظة UTC. */
function ammanToUtc(y, m, d, h = 0, min = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const t = guess - offsetMs(new Date(guess));
  return new Date(t - (offsetMs(new Date(t)) - offsetMs(new Date(guess))));
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function businessDay(date, startHour = 6) {
  const d = new Date(new Date(date).getTime() - startHour * 3600000);
  const p = parts(d);
  return ymd(p.year, p.month, p.day);
}
/** [بداية، نهاية) يوم العمل كلحظات UTC. */
function dayRange(day, startHour = 6) {
  const [y, m, d] = day.split('-').map(Number);
  const start = ammanToUtc(y, m, d, startHour);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  const end = ammanToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), startHour);
  return { start, end };
}
function addDays(day, k) {
  const [y, m, d] = day.split('-').map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + k));
  return ymd(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}
function daysBetween(from, to) { // شامل
  const out = []; let d = from;
  for (let i = 0; i < 400 && d <= to; i += 1) { out.push(d); d = addDays(d, 1); }
  return out;
}
function daysInMonth(day) {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

module.exports = { TZ, businessDay, dayRange, addDays, daysBetween, daysInMonth, isDay, ammanToUtc };
