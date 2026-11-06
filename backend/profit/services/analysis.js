/**
 * التحليلات: ربحية الأصناف والتصنيفات والقنوات، نقطة التعادل، المحاكاة، التوقع، والتنبيهات.
 * كل استنتاج مبني على أرقام فعلية ومعه مصدره؛ التوقعات والافتراضات معلَّمة صراحة.
 */
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Order = require('../../models/Order');
const Expense = require('../../models/Expense');
const ShiftSession = require('../../models/ShiftSession');
const SaleCost = require('../models/SaleCost');
const StockMovement = require('../models/StockMovement');
const Ingredient = require('../models/Ingredient');
const CostItem = require('../models/CostItem');
const { getConfig } = require('./config');
const { dayRange, businessDay, addDays, daysBetween, daysInMonth } = require('./time');
const { compute, comparableRange, explainChange, r3 } = require('./pnl');
const { productCard, makeCtx } = require('./costing');

const CHANNEL = { pos: 'سفري (كاشير)', 'web-delivery': 'المنصة — توصيل', 'web-pickup': 'المنصة — استلام', 'app-delivery': 'التطبيق — توصيل', 'app-pickup': 'التطبيق — استلام', center: 'سنتر هاتفي', hall: 'الصالة' };

async function rangeOf(from, to) { const cfg = await getConfig(); return { start: dayRange(from, cfg.dayStartHour).start, end: dayRange(to, cfg.dayStartHour).end, cfg }; }

/** ربحية الأصناف من اللقطات الفعلية + التكلفة النظرية الحالية للمقارنة. */
async function products(from, to) {
  const { start, end, cfg } = await rangeOf(from, to);
  const rows = await SaleCost.find({ kind: 'sale', reversed: { $ne: true }, at: { $gte: start, $lt: end } }).lean();
  const by = new Map();
  for (const c of rows) {
    const k = String(c.product || c.productName);
    if (!by.has(k)) by.set(k, { product: c.product, name: c.productName, category: c.category, qty: 0, revenue: 0, discounts: 0, cost: 0, material: 0, packaging: 0, uncostedQty: 0 });
    const r = by.get(k);
    r.qty += c.qty; r.revenue += c.revenue; r.discounts += c.discountShare || 0;
    if (c.missingRecipe) r.uncostedQty += c.qty; else { r.cost += c.cost; r.material += c.material; r.packaging += c.packaging; }
  }
  const prods = new Map((await Product.find({ _id: { $in: [...by.values()].map((r) => r.product).filter(Boolean) } }).lean()).map((p) => [String(p._id), p]));
  const ctx = makeCtx();
  const out = [];
  for (const r of by.values()) {
    const net = r.revenue - r.discounts; const costedShare = r.qty ? (r.qty - r.uncostedQty) / r.qty : 0;
    const profit = net * costedShare - r.cost;
    const p = r.product && prods.get(String(r.product));
    const card = p ? await productCard(p, ctx) : null;
    out.push({
      product: r.product, name: r.name, category: r.category, qty: r3(r.qty), revenue: r3(r.revenue), discounts: r3(r.discounts), netRevenue: r3(net),
      cost: r3(r.cost), unitCost: r.qty - r.uncostedQty ? r3(r.cost / (r.qty - r.uncostedQty)) : null,
      grossProfit: r3(profit), marginPct: net * costedShare ? r3((profit / (net * costedShare)) * 100) : null,
      foodCostPct: net * costedShare ? r3((r.cost / (net * costedShare)) * 100) : null,
      uncostedQty: r3(r.uncostedQty), currentPrice: p ? p.price : null, currentUnitCost: card ? card.unitCost : null, currentMarginPct: card ? card.marginPct : null,
      flag: r.uncostedQty ? 'missing' : profit < 0 ? 'loss' : net && (profit / net) * 100 < cfg.lowMarginPct ? 'low' : 'ok',
    });
  }
  out.sort((a, b) => b.grossProfit - a.grossProfit);
  return { rows: out, lowMarginPct: cfg.lowMarginPct };
}

async function categories(from, to) {
  const p = await products(from, to);
  const cats = new Map((await Category.find().lean()).map((c) => [String(c._id), c.nameAr || c.name]));
  const by = new Map();
  for (const r of p.rows) {
    const k = String(r.category || '');
    if (!by.has(k)) by.set(k, { category: r.category, name: cats.get(k) || 'بلا تصنيف', qty: 0, netRevenue: 0, cost: 0, grossProfit: 0, uncostedQty: 0 });
    const c = by.get(k); c.qty += r.qty; c.netRevenue += r.netRevenue; c.cost += r.cost; c.grossProfit += r.grossProfit; c.uncostedQty += r.uncostedQty;
  }
  return { rows: [...by.values()].map((c) => ({ ...c, qty: r3(c.qty), netRevenue: r3(c.netRevenue), cost: r3(c.cost), grossProfit: r3(c.grossProfit), marginPct: c.netRevenue ? r3((c.grossProfit / c.netRevenue) * 100) : null })).sort((a, b) => b.grossProfit - a.grossProfit) };
}

/** ربحية القنوات: مجمل الربح بعد التكلفة ورسوم القناة (البنود percent/per_order المرتبطة). */
async function channels(from, to) {
  const { start, end } = await rangeOf(from, to);
  const rows = await SaleCost.find({ kind: 'sale', reversed: { $ne: true }, at: { $gte: start, $lt: end } }).lean();
  const by = new Map();
  for (const c of rows) {
    const k = c.channel || 'pos';
    if (!by.has(k)) by.set(k, { channel: k, name: CHANNEL[k] || k, orders: new Set(), netRevenue: 0, cost: 0, uncosted: 0 });
    const r = by.get(k); r.orders.add(String(c.order)); r.netRevenue += c.revenue - (c.discountShare || 0); if (c.missingRecipe) r.uncosted += c.revenue; else r.cost += c.cost;
  }
  const deliveryFees = (await CostItem.find({ active: true, method: 'percent', percentBase: 'delivery' }).lean());
  return { rows: [...by.values()].map((r) => {
    const fee = r.channel.endsWith('delivery') ? deliveryFees.reduce((s, it) => s + (it.percent / 100) * r.netRevenue, 0) : 0;
    const gp = r.netRevenue - r.uncosted - r.cost - fee;
    return { channel: r.channel, name: r.name, orders: r.orders.size, netRevenue: r3(r.netRevenue), cost: r3(r.cost), channelFees: r3(fee), grossProfit: r3(gp), marginPct: r.netRevenue - r.uncosted ? r3((gp / (r.netRevenue - r.uncosted)) * 100) : null, avgTicket: r.orders.size ? r3(r.netRevenue / r.orders.size) : 0, uncostedRevenue: r3(r.uncosted) };
  }).sort((a, b) => b.grossProfit - a.grossProfit) };
}

/** تقرير مع مقارنة وتفسير. */
async function report(from, to) {
  const cur = await compute({ from, to });
  const cmp = comparableRange(from, to);
  const prev = await compute({ from: cmp.from, to: cmp.to });
  return { ...cur, comparison: { ...cmp, kpi: prev.statement.kpi, explanation: explainChange(cur.statement, prev.statement, cmp.label) } };
}

/**
 * نقطة التعادل اليومية من آخر 28 يوماً:
 *   الثابت اليومي   = (العمالة + البنود الموزّعة الثابتة + المصاريف التشغيلية) ÷ الأيام
 *   نسبة المتغيّر    = (تكلفة المبيعات + الهدر + البنود النسبية ولكل طلب) ÷ صافي المبيعات
 *   الحد الأدنى للإيراد اليومي = الثابت ÷ (1 − نسبة المتغيّر)
 */
async function breakEven(today) {
  const cfg = await getConfig();
  today = today || businessDay(new Date(), cfg.dayStartHour);
  const hist = await compute({ from: addDays(today, -28), to: addDays(today, -1) });
  const k = hist.statement.kpi; const n = hist.series.filter((d) => d.orders > 0).length || 0;
  const variableAlloc = hist.statement.lines.filter((l) => l.group === 'allocated' && /(%|طلب)/.test(l.formula)).reduce((s, l) => s - l.amount, 0);
  const fixedAlloc = k.allocated - variableAlloc;
  const now = await compute({ from: today, to: today });
  if (!n || !k.netSales) {
    // بلا تاريخ: من بيانات اليوم والبنود فقط (تقديري)
    const kn = now.statement.kpi;
    const varRatio = kn.netSales ? (kn.cogs + kn.waste) / kn.netSales : null;
    return { basis: 'estimated', note: 'لا يوجد تاريخ كافٍ (28 يوماً) — التقدير من اليوم الحالي فقط', fixedDaily: r3(kn.allocated + kn.labor + kn.opex), variableRatio: varRatio != null ? r3(varRatio) : null,
      ...(() => { const be = varRatio != null && varRatio < 1 ? (kn.allocated + kn.labor + kn.opex) / (1 - varRatio) : null;
        return { breakEvenSales: be != null ? r3(be) : null, todaySales: kn.netSales, progressPct: be ? r3((kn.netSales / be) * 100) : null, formula: be != null ? `ثابت اليوم ${r3(kn.allocated + kn.labor + kn.opex)} ÷ (1 − نسبة المتغيّر ${r3(varRatio * 100)}%)` : '' }; })() };
  }
  const fixedDaily = (k.labor + fixedAlloc + k.opex) / n;
  const variableRatio = (k.cogs + k.waste + k.shrinkage + variableAlloc) / k.netSales;
  const be = variableRatio < 1 ? fixedDaily / (1 - variableRatio) : null;
  return {
    basis: 'estimated', days: n,
    formula: `الثابت اليومي ${r3(fixedDaily)} ÷ (1 − نسبة التكاليف المتغيّرة ${r3(variableRatio * 100)}%)`,
    fixedDaily: r3(fixedDaily), variableRatio: r3(variableRatio), contributionMarginPct: r3((1 - variableRatio) * 100),
    breakEvenSales: be != null ? r3(be) : null, todaySales: now.statement.kpi.netSales,
    progressPct: be ? r3((now.statement.kpi.netSales / be) * 100) : null,
    monthlyBreakEven: be != null ? r3(be * daysInMonth(today)) : null,
  };
}

/** محاكاة: تغيير سعر صنف، ارتفاع سعر مادة، زيادة الأجور — على كميات فترة فعلية (افتراض ثبات الكميات). */
async function simulate(b) {
  const cfg = await getConfig();
  const to = b.to || addDays(businessDay(new Date(), cfg.dayStartHour), -1);
  const from = b.from || addDays(to, -27);
  const { start, end } = await rangeOf(from, to);
  const base = await compute({ from, to });
  const k = base.statement.kpi;
  let delta = 0; const details = [];
  const assumptions = ['الكميات المباعة ثابتة كما في الفترة الفعلية (لا يُفترض تغيّر الطلب)'];
  for (const pc of b.priceChanges || []) {
    const rows = await SaleCost.find({ kind: 'sale', reversed: { $ne: true }, product: pc.product, at: { $gte: start, $lt: end } }).lean();
    const qty = rows.reduce((s, r) => s + r.qty, 0);
    const p = await Product.findById(pc.product).select('nameAr price').lean();
    if (!p) continue;
    const d = (Number(pc.newPrice) - p.price) * qty; delta += d;
    details.push({ type: 'price', name: p.nameAr, from: p.price, to: Number(pc.newPrice), qty: r3(qty), impact: r3(d) });
  }
  for (const ic of b.ingredientChanges || []) {
    const pct = Number(ic.pct) || 0;
    const rows = await SaleCost.find({ reversed: { $ne: true }, at: { $gte: start, $lt: end }, 'components.ingredient': ic.ingredient }).lean();
    let cost = 0; const affected = new Map();
    for (const r of rows) for (const c of r.components) if (String(c.ingredient) === String(ic.ingredient)) { cost += c.cost; affected.set(r.productName, (affected.get(r.productName) || 0) + c.cost * pct / 100); }
    const ing = await Ingredient.findById(ic.ingredient).select('name').lean();
    const d = -cost * pct / 100; delta += d;
    details.push({ type: 'ingredient', name: ing ? ing.name : '', pct, baseCost: r3(cost), impact: r3(d), affected: [...affected.entries()].map(([n, v]) => ({ name: n, extraCost: r3(v) })).sort((a, b2) => b2.extraCost - a.extraCost).slice(0, 10) });
  }
  if (b.wagePct) {
    const d = -k.labor * Number(b.wagePct) / 100; delta += d;
    details.push({ type: 'wages', pct: Number(b.wagePct), baseLabor: k.labor, impact: r3(d) });
  }
  const days = base.range.days;
  return {
    basis: 'forecast', from, to, days, assumptions,
    baseOperatingProfit: k.operatingProfit, newOperatingProfit: r3(k.operatingProfit + delta), impact: r3(delta),
    monthlyImpact: r3((delta / days) * 30), details,
  };
}

/** توقع الشهر: الفعلي حتى أمس + متوسط آخر 28 يوماً × الأيام المتبقية (معلَّم «متوقع»). */
async function forecastMonth(today) {
  const cfg = await getConfig();
  today = today || businessDay(new Date(), cfg.dayStartHour);
  const monthStart = `${today.slice(0, 8)}01`;
  const dim = daysInMonth(today); const dayNo = Number(today.slice(8));
  const mtd = dayNo > 1 ? await compute({ from: monthStart, to: addDays(today, -1) }) : null;
  const hist = await compute({ from: addDays(today, -28), to: addDays(today, -1) });
  const active = hist.series.filter((d) => d.orders > 0);
  if (!active.length) return { basis: 'forecast', note: 'لا يوجد تاريخ كافٍ للتوقع', available: false };
  const avgSales = active.reduce((s, d) => s + d.netSales, 0) / active.length;
  const avgProfit = active.reduce((s, d) => s + d.operatingProfit, 0) / active.length;
  const remaining = dim - dayNo + 1;
  const actualSales = mtd ? mtd.statement.kpi.netSales : 0; const actualProfit = mtd ? mtd.statement.kpi.operatingProfit : 0;
  return {
    basis: 'forecast', available: true, month: today.slice(0, 7), daysElapsed: dayNo - 1, daysRemaining: remaining,
    actual: { netSales: r3(actualSales), operatingProfit: r3(actualProfit), basis: 'actual' },
    forecast: { netSales: r3(actualSales + avgSales * remaining), operatingProfit: r3(actualProfit + avgProfit * remaining) },
    formula: `الفعلي حتى أمس + متوسط آخر ${active.length} يوم عمل (${r3(avgProfit)} ربح/يوم) × ${remaining} يوم متبقٍ`,
    assumptions: ['الأيام القادمة تشبه متوسط آخر 4 أسابيع', 'لا تغيّر في الأسعار أو التكاليف الثابتة'],
  };
}

/** التنبيهات الذكية — كل تنبيه بأرقامه ومصدره. */
async function insights(today) {
  const cfg = await getConfig();
  today = today || businessDay(new Date(), cfg.dayStartHour);
  const from = addDays(today, -13); const to = today;
  const out = [];
  const p = await products(from, to);
  for (const r of p.rows.filter((x) => x.flag === 'loss').slice(0, 5)) out.push({ level: 'error', kind: 'loss_product', text: `«${r.name}» يُباع بخسارة: تكلفته ${r.unitCost} وصافي ربحه ${r.grossProfit} على ${r.qty} قطعة (آخر 14 يوماً).`, drill: { type: 'product', id: r.product } });
  for (const r of p.rows.filter((x) => x.flag === 'low').slice(0, 5)) out.push({ level: 'warn', kind: 'low_margin', text: `هامش «${r.name}» ${r.marginPct}% أقل من الحد ${cfg.lowMarginPct}% (تكلفة القطعة ${r.unitCost}).`, drill: { type: 'product', id: r.product } });
  const missing = p.rows.filter((x) => x.flag === 'missing');
  if (missing.length) out.push({ level: 'warn', kind: 'missing_recipes', text: `${missing.length} صنف مُباع بلا وصفة — أكثرها مبيعاً: ${missing.sort((a, b) => b.qty - a.qty).slice(0, 4).map((x) => x.name).join('، ')}.`, drill: { type: 'saleCosts', missing: true } });
  // ارتفاع أسعار المواد: آخر استلام مقابل متوسط الاستلامات قبله (60 يوماً)
  const recv = await StockMovement.find({ type: 'receive', at: { $gte: new Date(Date.now() - 60 * 864e5) } }).sort({ at: 1 }).lean();
  const byIng = new Map(); recv.forEach((m) => { const k = String(m.ingredient); if (!byIng.has(k)) byIng.set(k, []); byIng.get(k).push(m); });
  for (const [, list] of byIng) {
    if (list.length < 2) continue;
    const last = list[list.length - 1]; const prev = list.slice(0, -1);
    const avg = prev.reduce((s, m) => s + m.value, 0) / prev.reduce((s, m) => s + m.qty, 0);
    const rise = avg ? ((last.unitCost - avg) / avg) * 100 : 0;
    if (rise >= cfg.priceRiseAlertPct) out.push({ level: 'warn', kind: 'price_rise', text: `سعر «${last.ingredientName}» ارتفع ${r3(rise)}% في آخر استلام عن متوسط ما قبله.`, drill: { type: 'priceHistory', id: last.ingredient } });
  }
  // الهدر والعمالة غير الطبيعية
  const cur = await compute({ from, to });
  const k = cur.statement.kpi;
  if (k.cogs && ((k.waste + k.shrinkage) / k.cogs) * 100 > cfg.wasteAlertPct) out.push({ level: 'warn', kind: 'waste', text: `الهدر وعجز الجرد ${r3(k.waste + k.shrinkage)} دينار = ${r3(((k.waste + k.shrinkage) / k.cogs) * 100)}% من تكلفة المبيعات (الحد ${cfg.wasteAlertPct}%) خلال 14 يوماً.`, drill: { type: 'movements', types: ['waste', 'expired', 'count'] } });
  const days = cur.series.filter((d) => d.netSales > 0);
  if (days.length >= 5) {
    const avgPct = days.reduce((s, d) => s + d.labor / d.netSales, 0) / days.length;
    for (const d of days.slice(-7)) if (d.labor / d.netSales > avgPct * 1.3 && d.labor > 5) out.push({ level: 'info', kind: 'labor', text: `عمالة يوم ${d.day} = ${r3((d.labor / d.netSales) * 100)}% من مبيعاته مقابل متوسط ${r3(avgPct * 100)}%.`, drill: { type: 'day', day: d.day } });
  }
  const neg = await Ingredient.find({ active: true, stockQty: { $lt: -0.001 } }).select('name stockQty baseUnit').lean();
  if (neg.length) out.push({ level: 'warn', kind: 'negative_stock', text: `رصيد سالب لـ ${neg.length} مادة (مبيعات بلا استلام مسجّل): ${neg.slice(0, 5).map((x) => x.name).join('، ')}.`, drill: { type: 'inventory' } });
  const low = await Ingredient.find({ active: true, minStock: { $gt: 0 } }).lean();
  const lows = low.filter((i) => (i.stockQty || 0) <= i.minStock);
  if (lows.length) out.push({ level: 'info', kind: 'reorder', text: `للشراء (تحت الحد الأدنى): ${lows.slice(0, 8).map((x) => x.name).join('، ')}.`, drill: { type: 'inventory' } });
  return { from, to, items: out };
}

/** تقرير جرد/وردية: ربحية الفترة + مطابقة النقد من سجل الجرد نفسه. */
async function shiftReport(shiftId) {
  const s = await ShiftSession.findOne({ shiftId: String(shiftId) }).lean();
  if (!s) throw Object.assign(new Error('الجرد غير موجود'), { status: 404 });
  const start = s.periodStart || s.openedAt; const end = s.closedAt || new Date();
  const res = await compute({ start, end }, { prorate: true });
  return { shift: { shiftId: s.shiftId, userName: s.userName, scope: s.scope, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt, openedByName: s.openedByName, closedByName: s.closedByName,
    cash: { expected: s.cashNet, actual: s.actualCash, diff: s.cashDiff, cliqExpected: s.cliqNet, cliqActual: s.actualCliq, cliqDiff: s.cliqDiff, reason: s.diffReason, salesTotal: s.salesTotal, expensesTotal: s.expensesTotal } }, ...res };
}

/** التتبع حتى المصدر: كل رقم في القائمة يفتح حركاته. */
async function drill(q) {
  const { start, end } = q.from ? await rangeOf(q.from, q.to || q.from) : { start: new Date(q.start), end: new Date(q.end) };
  const lim = Math.min(Number(q.limit) || 300, 1000);
  switch (q.type) {
    case 'saleCosts': {
      const f = { at: { $gte: start, $lt: end }, kind: q.kind || 'sale' };
      if (q.missing === 'true' || q.missing === true) f.missingRecipe = true;
      if (q.product) f.product = q.product;
      return (await SaleCost.find(f).sort({ at: -1 }).limit(lim).lean()).map((c) => ({ at: c.at, orderNumber: c.orderNumber, product: c.productName, qty: c.qty, revenue: c.revenue, discountShare: c.discountShare, cost: c.cost, recipeVersion: c.recipeVersion, missingRecipe: c.missingRecipe, reversed: c.reversed, employee: c.employeeName, components: c.components }));
    }
    case 'movements': {
      const types = String(q.types || '').split(',').filter(Boolean);
      const f = { at: { $gte: start, $lt: end } }; if (types.length) f.type = { $in: types }; if (q.ingredient) f.ingredient = q.ingredient;
      return StockMovement.find(f).sort({ at: -1 }).limit(lim).select('at type ingredientName qty unitCost value reason byName refType refId').lean();
    }
    case 'orders':
      return Order.find({ createdAt: { $gte: start, $lt: end }, status: { $nin: ['pending'] } }).sort({ createdAt: -1 }).limit(lim).select('orderNumber status itemsTotal discount deliveryFee total paymentMethod orderType source createdAt customerName').lean();
    case 'expenses': {
      const f = { voided: { $ne: true }, $or: [{ spentAt: { $gte: start, $lt: end } }, { spentAt: null, createdAt: { $gte: start, $lt: end } }] };
      if (q.category) f.category = q.category === 'بلا فئة' ? '' : q.category;
      return Expense.find(f).sort({ createdAt: -1 }).limit(lim).select('number name amount category kind paidTo employeeName obligation createdByName createdAt spentAt source').lean();
    }
    default: throw Object.assign(new Error('نوع تتبع غير معروف'), { status: 400 });
  }
}

module.exports = { products, categories, channels, report, breakEven, simulate, forecastMonth, insights, shiftReport, drill, CHANNEL, daysBetween };
