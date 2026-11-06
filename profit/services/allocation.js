/**
 * توزيع بنود التكلفة على يوم عمل واحد — كل نتيجة معها طريقتها وتصنيفها:
 *   actual    فعلي (فاتورة تغطي اليوم)
 *   allocated موزّع من مبلغ معروف (إيجار شهري، إهلاك)
 *   estimated تقديري (متوسط فواتير سابقة، نسبة، لكل طلب)
 */
const { daysInMonth, daysBetween } = require('./time');

const r3 = (n) => Math.round(n * 1000) / 1000;
const billDays = (b) => daysBetween(b.from, b.to).length || 1;

function monthsBetween(a, b) { // عدد الأشهر الكاملة من a إلى b (للإهلاك)
  const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

/**
 * @param stats { orders, netSales, cardSales, deliverySales } لذلك اليوم
 */
function allocateDay(item, day, stats) {
  if (!item.active && !item.endDate) return null;
  if (day < item.startDate || (item.endDate && day > item.endDate)) return null;
  const dim = daysInMonth(day);
  switch (item.method) {
    case 'monthly':
      return { amount: item.amount / dim, basis: 'allocated', formula: `${item.amount} شهرياً ÷ ${dim} يوم` };
    case 'depreciation': {
      if (!(item.lifeMonths > 0)) return { amount: 0, basis: 'missing', formula: 'العمر الإنتاجي غير محدد' };
      if (monthsBetween(item.startDate, day) >= item.lifeMonths) return null; // انتهى عمره
      const monthly = Math.max(0, item.assetCost - item.salvage) / item.lifeMonths;
      return { amount: monthly / dim, basis: 'allocated', formula: `(${item.assetCost} − ${item.salvage}) ÷ ${item.lifeMonths} شهر ÷ ${dim} يوم` };
    }
    case 'bills': {
      const bills = (item.bills || []).slice().sort((a, b) => (a.to < b.to ? -1 : 1));
      const cover = bills.find((b) => b.from <= day && day <= b.to);
      if (cover) return { amount: cover.amount / billDays(cover), basis: 'actual', formula: `فاتورة ${cover.from}→${cover.to}: ${cover.amount} ÷ ${billDays(cover)} يوم` };
      const prev = bills.filter((b) => b.to < day).slice(-3);
      if (!prev.length) return { amount: 0, basis: 'missing', formula: 'لا توجد فاتورة بعد' };
      const amt = prev.reduce((s, b) => s + b.amount, 0); const ds = prev.reduce((s, b) => s + billDays(b), 0);
      return { amount: amt / ds, basis: 'estimated', formula: `متوسط آخر ${prev.length} فاتورة: ${r3(amt)} ÷ ${ds} يوم` };
    }
    case 'per_order':
      return { amount: item.amount * (stats.orders || 0), basis: 'estimated', formula: `${item.amount} × ${stats.orders || 0} طلب` };
    case 'percent': {
      const base = item.percentBase === 'card' ? stats.cardSales : item.percentBase === 'delivery' ? stats.deliverySales : stats.netSales;
      const label = { card: 'مبيعات البطاقة/الإلكتروني', delivery: 'مبيعات التوصيل', net: 'صافي المبيعات' }[item.percentBase] || 'صافي المبيعات';
      return { amount: (item.percent / 100) * (base || 0), basis: 'estimated', formula: `${item.percent}% × ${label} ${r3(base || 0)}` };
    }
    default: return null;
  }
}

module.exports = { allocateDay, billDays };
