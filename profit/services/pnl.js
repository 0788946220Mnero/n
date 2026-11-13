/**
 * محرك الربحية: يجمع المبيعات ولقطات التكلفة والعمالة والهدر والجرد والمصاريف والبنود الموزّعة
 * لكل يوم عمل، ثم يبني قائمة دخل مفسَّرة — كل سطر: المبلغ، تصنيفه، معادلته، ومصدره للتتبع.
 *
 *   صافي المبيعات      = قيمة الأصناف − خصم الفواتير (+ التوصيل إن فُعّل في الإعدادات)
 *   مجمل الربح         = صافي المبيعات − تكلفة المبيعات (لقطات SaleCost)
 *   الربح التشغيلي     = مجمل الربح − العمالة − وجبات الموظفين − الهدر والتالف − عجز الجرد
 *                        − البنود الموزّعة − المصاريف التشغيلية الفعلية
 *   حركة النقد منفصلة تماماً: ما دخل الدرج وما خرج منه (شراء بضاعة، رواتب، أقساط…)
 */
const Order = require('../../models/Order');
const Expense = require('../../models/Expense');
const ShiftSession = require('../../models/ShiftSession');
const SaleCost = require('../models/SaleCost');
const StockMovement = require('../models/StockMovement');
const CostItem = require('../models/CostItem');
const { getConfig } = require('./config');
const { businessDay, dayRange, daysBetween, addDays } = require('./time');
const { laborForDays } = require('./labor');
const { allocateDay } = require('./allocation');

const r3 = (n) => Math.round((n || 0) * 1000) / 1000;
const NOT_SALES = ['pending', 'cancelled'];
const PAY_KINDS = ['salary', 'advance', 'bonus'];
const saleAt = (o) => new Date(o.offlineSoldAt || o.createdAt);
const BASIS_RANK = { actual: 0, allocated: 1, estimated: 2, missing: 3 };
const worst = (a, b) => (BASIS_RANK[a] >= BASIS_RANK[b] ? a : b);

function emptyDay() {
  return {
    orders: 0, itemsTotal: 0, promotions: 0, discounts: 0, deliveryFees: 0, netSales: 0, cancelledCount: 0, cancelledValue: 0,
    cashSales: 0, cliqSales: 0, cardSales: 0, deliverySales: 0,
    cogs: 0, costedRevenue: 0, uncostedRevenue: 0, uncostedLines: 0, staffMeals: 0, productWaste: 0,
    ingredientWaste: 0, shrinkage: 0, labor: 0, laborEstimated: false, allocated: 0, allocBasis: 'actual', opex: 0,
    cashOutExpenses: 0, cashOutPayroll: 0, cashOutInventory: 0, cashOutObligations: 0, allocLines: new Map(), opexLines: new Map(),
  };
}

/**
 * @param {{from:string,to:string}} | {{start:Date,end:Date}} range
 * @param {{prorate?: boolean, withLabor?: boolean}} opts prorate: البنود الموزّعة بنسبة تغطية الفترة من اليوم (للورديات)
 */
async function compute(range, opts = {}) {
  const cfg = await getConfig();
  const sh = cfg.dayStartHour;
  let start; let end;
  if (range.start) { start = new Date(range.start); end = new Date(range.end); } else { start = dayRange(range.from, sh).start; end = dayRange(range.to, sh).end; }
  const now = new Date();
  const days = daysBetween(businessDay(start, sh), businessDay(new Date(Math.min(end.getTime(), now.getTime() + 864e5) - 1), sh));
  const D = new Map(days.map((d) => [d, emptyDay()]));
  const dayOf = (t) => businessDay(t, sh);
  const inRange = (t) => t >= start && t < end;
  const get = (t) => D.get(dayOf(t));

  // ── المبيعات ──
  const orders = await Order.find({ createdAt: { $gte: new Date(start.getTime() - 3 * 864e5), $lt: end } })
    .select('orderNumber status items itemsTotal discount deliveryFee total paymentMethod orderType source createdAt offlineSoldAt shiftId').lean();
  for (const o of orders) {
    const t = saleAt(o); if (!inRange(t)) continue;
    const d = get(t); if (!d) continue;
    const promo = (o.items || []).reduce((s, i) => s + (Number(i.offerDiscount) || 0) * (Number(i.quantity) || 1), 0);
    if (o.status === 'cancelled') { d.cancelledCount += 1; d.cancelledValue += o.itemsTotal || 0; continue; }
    if (NOT_SALES.includes(o.status)) continue;
    d.orders += 1; d.itemsTotal += o.itemsTotal || 0; d.promotions += promo; d.discounts += o.discount || 0; d.deliveryFees += o.deliveryFee || 0;
    const net = (o.itemsTotal || 0) - (o.discount || 0) + (cfg.includeDeliveryFeeInRevenue ? (o.deliveryFee || 0) : 0);
    d.netSales += net;
    if (o.paymentMethod === 'cash') d.cashSales += o.total || 0; else if (o.paymentMethod === 'cliq') d.cliqSales += o.total || 0; else d.cardSales += o.total || 0;
    if (o.orderType === 'delivery') d.deliverySales += net;
  }

  // ── لقطات التكلفة ──
  const costs = await SaleCost.find({ at: { $gte: start, $lt: end } }).lean();
  for (const c of costs) {
    const d = get(new Date(c.at)); if (!d) continue;
    if (c.kind === 'sale') {
      if (c.reversed) continue;
      d.cogs += c.cost || 0;
      if (c.missingRecipe) { d.uncostedRevenue += c.revenue || 0; d.uncostedLines += 1; } else d.costedRevenue += c.revenue || 0;
    } else if (c.kind === 'staff_meal') d.staffMeals += c.cost || 0;
    else if (c.kind === 'product_waste') d.productWaste += c.cost || 0;
  }

  // ── هدر المواد والجرد ──
  const moves = await StockMovement.find({ at: { $gte: start, $lt: end }, type: { $in: ['waste', 'expired', 'count', 'adjust'] } }).lean();
  for (const m of moves) {
    const d = get(new Date(m.at)); if (!d) continue;
    if (m.type === 'waste' || m.type === 'expired') d.ingredientWaste += -(m.value || 0);
    else d.shrinkage += -(m.value || 0); // عجز موجب، زيادة سالبة
  }

  // ── المصاريف: التشغيلي الفعلي مقابل حركة النقد ──
  const invCats = new Set((cfg.inventoryExpenseCategories || []).map((x) => String(x).trim()));
  const exps = await Expense.find({ voided: { $ne: true }, $or: [{ spentAt: { $gte: start, $lt: end } }, { spentAt: null, createdAt: { $gte: start, $lt: end } }] }).lean();
  for (const e of exps) {
    const t = new Date(e.spentAt || e.createdAt); if (!inRange(t)) continue;
    const d = get(t); if (!d) continue;
    const amt = e.amount || 0;
    if (e.source !== 'capital') d.cashOutExpenses += amt;
    if (PAY_KINDS.includes(e.kind) || e.employee) { d.cashOutPayroll += amt; continue; } // العمالة تُحسب من الدوام لا من الصرف
    if (e.obligation) { d.cashOutObligations += amt; continue; }                       // قسط التزام = سداد بند موزّع
    if (invCats.has(String(e.category || '').trim())) { d.cashOutInventory += amt; continue; } // شراء بضاعة = مخزون لا مصروف
    d.opex += amt;
    const k = e.category || 'بلا فئة';
    d.opexLines.set(k, (d.opexLines.get(k) || 0) + amt);
  }

  // ── العمالة ──
  const labor = opts.withLabor === false ? { byDay: new Map(), rows: [], missing: [] } : await laborForDays(days, cfg, now);
  for (const [day, l] of labor.byDay) { const d = D.get(day); if (d) { d.labor += l.cost; d.laborEstimated = l.estimated; } }

  // ── البنود الموزّعة ──
  const items = await CostItem.find({ $or: [{ active: true }, { endDate: { $ne: '' } }] }).lean();
  for (const day of days) {
    const d = D.get(day);
    let frac = 1;
    if (opts.prorate) {
      const r = dayRange(day, sh);
      const ov = Math.max(0, Math.min(end, now, r.end) - Math.max(start, r.start));
      frac = ov / (r.end - r.start);
    }
    for (const it of items) {
      const a = allocateDay(it, day, d); if (!a) continue;
      const amt = ['per_order', 'percent'].includes(it.method) ? a.amount : a.amount * frac;
      d.allocated += amt; d.allocBasis = worst(d.allocBasis, a.basis);
      const prev = d.allocLines.get(String(it._id)) || { id: it._id, name: it.name, category: it.category, method: it.method, amount: 0, basis: 'actual', formula: a.formula };
      prev.amount += amt; prev.basis = worst(prev.basis, a.basis); prev.formula = a.formula + (frac < 1 && !['per_order', 'percent'].includes(it.method) ? ` × ${r3(frac)} من اليوم` : '');
      d.allocLines.set(String(it._id), prev);
    }
  }

  // ── التجميع ──
  const T = emptyDay();
  const allocTotal = new Map(); const opexTotal = new Map();
  for (const d of D.values()) {
    for (const k of Object.keys(T)) if (typeof T[k] === 'number') T[k] += d[k];
    T.laborEstimated = T.laborEstimated || d.laborEstimated; T.allocBasis = worst(T.allocBasis, d.allocBasis);
    for (const [k, v] of d.allocLines) { const p = allocTotal.get(k) || { ...v, amount: 0 }; p.amount += v.amount; p.basis = worst(p.basis, v.basis); allocTotal.set(k, p); }
    for (const [k, v] of d.opexLines) opexTotal.set(k, (opexTotal.get(k) || 0) + v);
  }
  const series = days.map((day) => ({ day, ...summarize(D.get(day)) }));
  const shiftsClosed = await ShiftSession.find({ status: 'closed', closedAt: { $gte: start, $lt: end } }).select('shiftId userName cashDiff cliqDiff diffReason closedAt').lean();

  return {
    range: { start, end, from: days[0], to: days[days.length - 1], days: days.length, live: end > now },
    config: { dayStartHour: sh, startedAt: cfg.startedAt, includeDeliveryFeeInRevenue: cfg.includeDeliveryFeeInRevenue, enabled: cfg.enabled },
    statement: statement(T, { allocTotal, opexTotal, labor, cfg }),
    cash: cashView(T, shiftsClosed),
    labor: { rows: labor.rows, missing: labor.missing },
    series,
    warnings: warnings(T, labor, cfg, start),
  };
}

function summarize(d) {
  const gross = d.netSales - d.cogs;
  const op = gross - d.labor - d.staffMeals - d.productWaste - d.ingredientWaste - d.shrinkage - d.allocated - d.opex;
  return { orders: d.orders, netSales: r3(d.netSales), cogs: r3(d.cogs), grossProfit: r3(gross), labor: r3(d.labor), allocated: r3(d.allocated), opex: r3(d.opex),
    waste: r3(d.productWaste + d.ingredientWaste), operatingProfit: r3(op), uncostedRevenue: r3(d.uncostedRevenue) };
}

function line(key, label, amount, basis, formula, drill, extra = {}) {
  return { key, label, amount: r3(amount), basis, formula, drill: drill || null, ...extra };
}

function statement(T, { allocTotal, opexTotal, labor, cfg }) {
  const gross = T.netSales - T.cogs;
  const coverage = T.costedRevenue + T.uncostedRevenue > 0 ? T.costedRevenue / (T.costedRevenue + T.uncostedRevenue) : 1;
  const lines = [
    line('grossSales', 'إجمالي المبيعات (قبل العروض)', T.itemsTotal + T.promotions, 'actual', 'قيمة الأصناف بأسعار المنيو', { type: 'orders' }),
    line('promotions', 'عروض ترويجية', -T.promotions, 'actual', 'خصم العروض على الأسطر', { type: 'orders', filter: 'offers' }),
    line('discounts', 'خصومات الفواتير', -T.discounts, 'actual', 'خصم مسجّل على الفاتورة', { type: 'orders', filter: 'discount' }),
    line('refunds', 'المرتجعات', 0, 'actual', 'لا يوجد استرجاع في النظام — الطلب الملغى لا يُحتسب مبيعاً', null, { note: `ملغاة: ${T.cancelledCount} بقيمة ${r3(T.cancelledValue)}` }),
    ...(cfg.includeDeliveryFeeInRevenue ? [line('deliveryFees', 'رسوم التوصيل', T.deliveryFees, 'actual', 'محسوبة إيراداً حسب الإعدادات', { type: 'orders', filter: 'delivery' })] : []),
    line('netSales', 'صافي المبيعات', T.netSales, 'actual', `قيمة الأصناف − الخصومات${cfg.includeDeliveryFeeInRevenue ? ' + التوصيل' : ' (رسوم التوصيل أمانة للمندوبين — خارج الإيراد)'}`, { type: 'orders' }, { total: true }),
    line('cogs', 'تكلفة المبيعات (المواد والتغليف)', -T.cogs, T.uncostedRevenue > 0 ? 'missing' : 'actual', `مجموع لقطات التكلفة لحظة البيع (نسخة الوصفة + متوسط تكلفة المواد)${T.uncostedLines ? ` — ${T.uncostedLines} سطر بلا وصفة بقيمة ${r3(T.uncostedRevenue)} غير مكلَّف` : ''}`, { type: 'saleCosts' }, { coveragePct: r3(coverage * 100) }),
    line('grossProfit', 'مجمل الربح', gross, T.uncostedRevenue > 0 ? 'missing' : 'actual', 'صافي المبيعات − تكلفة المبيعات', null, { total: true, pctOfSales: T.netSales ? r3((gross / T.netSales) * 100) : null }),
    line('labor', 'تكلفة العمالة', -T.labor, labor.missing.length ? 'missing' : T.laborEstimated ? 'estimated' : 'allocated', `دقائق الدوام الفعلية بعد الاستراحات × أجر الساعة (+ إضافي × ${cfg.overtimeMultiplier})${labor.missing.length ? ` — بلا أجر: ${labor.missing.join('، ')}` : ''}${T.laborEstimated ? ' — يشمل دواماً مفتوحاً حتى الآن' : ''}`, { type: 'labor' }),
    line('staffMeals', 'وجبات الموظفين (استهلاك داخلي)', -T.staffMeals, 'actual', 'تكلفة مكوّنات الوجبات — ليست إيراداً', { type: 'saleCosts', kind: 'staff_meal' }),
    line('productWaste', 'أصناف تالفة', -T.productWaste, 'actual', 'تكلفة مكوّنات الأصناف التالفة', { type: 'saleCosts', kind: 'product_waste' }),
    line('ingredientWaste', 'هدر وتلف المواد', -T.ingredientWaste, 'actual', 'حركات هدر/انتهاء صلاحية × متوسط التكلفة', { type: 'movements', types: ['waste', 'expired'] }),
    line('shrinkage', 'عجز الجرد (فرق غير مفسَّر)', -T.shrinkage, 'actual', 'المعدود − المتوقع من الدفتر × متوسط التكلفة (الزيادة تُخفّضه)', { type: 'movements', types: ['count', 'adjust'] }),
    ...[...allocTotal.values()].sort((a, b) => b.amount - a.amount).map((a) => line(`alloc:${a.id}`, a.name, -a.amount, a.basis, a.formula, { type: 'costItem', id: a.id }, { group: 'allocated', category: a.category })),
    ...[...opexTotal.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => line(`opex:${k}`, `مصاريف: ${k}`, -v, 'actual', 'سندات صرف مسجّلة (بلا رواتب ولا أقساط التزامات ولا شراء بضاعة)', { type: 'expenses', category: k }, { group: 'opex' })),
  ];
  const op = gross - T.labor - T.staffMeals - T.productWaste - T.ingredientWaste - T.shrinkage - T.allocated - T.opex;
  const basis = [T.uncostedRevenue > 0 ? 'missing' : 'actual', T.laborEstimated ? 'estimated' : 'allocated', T.allocBasis].reduce(worst, 'actual');
  lines.push(line('operatingProfit', op >= 0 ? 'الربح التشغيلي' : 'الخسارة التشغيلية', op, basis, 'مجمل الربح − العمالة − الاستهلاك الداخلي − الهدر − عجز الجرد − البنود الموزّعة − المصاريف التشغيلية', null, { total: true, pctOfSales: T.netSales ? r3((op / T.netSales) * 100) : null }));
  return {
    lines,
    kpi: {
      orders: T.orders, netSales: r3(T.netSales), cogs: r3(T.cogs), grossProfit: r3(gross), operatingProfit: r3(op), labor: r3(T.labor), allocated: r3(T.allocated), opex: r3(T.opex),
      waste: r3(T.productWaste + T.ingredientWaste), shrinkage: r3(T.shrinkage), staffMeals: r3(T.staffMeals),
      avgTicket: T.orders ? r3(T.netSales / T.orders) : 0,
      foodCostPct: T.costedRevenue ? r3((T.cogs / T.costedRevenue) * 100) : null,
      laborPct: T.netSales ? r3((T.labor / T.netSales) * 100) : null,
      primeCostPct: T.netSales ? r3(((T.cogs + T.labor) / T.netSales) * 100) : null,
      costCoveragePct: r3(coverage * 100), basis, profitable: op >= 0,
    },
  };
}

function cashView(T, shifts) {
  const inflow = T.cashSales + T.cliqSales;
  const out = T.cashOutExpenses;
  return {
    note: 'حركة النقد ليست الربح: شراء البضاعة يخرج نقداً اليوم ويُستهلك لاحقاً، والإيجار يُستحق يومياً ويُدفع مرة.',
    lines: [
      line('cashSales', 'مبيعات نقدية', T.cashSales, 'actual', 'طلبات بطريقة دفع نقد (شاملة التوصيل)', { type: 'orders', filter: 'cash' }),
      line('cliqSales', 'مبيعات كليك', T.cliqSales, 'actual', 'طلبات بطريقة دفع كليك', { type: 'orders', filter: 'cliq' }),
      line('cardSales', 'بطاقة / إلكتروني (لا يدخل الدرج)', T.cardSales, 'actual', 'بطاقة أو دفع إلكتروني', { type: 'orders', filter: 'card' }),
      line('outPayroll', 'رواتب وسلف مصروفة', -T.cashOutPayroll, 'actual', 'سندات صرف للموظفين', { type: 'expenses', filter: 'payroll' }),
      line('outInventory', 'شراء بضاعة', -T.cashOutInventory, 'actual', 'مصروفات بفئات شراء البضاعة (من الإعدادات)', { type: 'expenses', filter: 'inventory' }),
      line('outObligations', 'أقساط الالتزامات الثابتة', -T.cashOutObligations, 'actual', 'دفعات يومية للإيجار والاشتراكات', { type: 'expenses', filter: 'obligations' }),
      line('outOther', 'مصاريف أخرى مدفوعة', -(out - T.cashOutPayroll - T.cashOutInventory - T.cashOutObligations), 'actual', 'باقي سندات الصرف من الدرج', { type: 'expenses', filter: 'other' }),
      line('netCash', 'صافي حركة النقد (نقد + كليك)', inflow - out, 'actual', 'مبيعات نقد وكليك − كل ما صُرف من الدرج', null, { total: true }),
    ],
    shiftDiffs: shifts.map((s) => ({ shiftId: s.shiftId, userName: s.userName, cashDiff: s.cashDiff, cliqDiff: s.cliqDiff, reason: s.diffReason, closedAt: s.closedAt })),
    totalCashDiff: r3(shifts.reduce((s, x) => s + (x.cashDiff || 0), 0)),
  };
}

function warnings(T, labor, cfg, start) {
  const w = [];
  if (!cfg.enabled) w.push({ level: 'error', text: 'محرك الربحية غير مفعّل — لا تُرحَّل تكلفة المبيعات بعد. فعّله من الإعدادات.' });
  if (cfg.startedAt && start < new Date(cfg.startedAt)) w.push({ level: 'warn', text: `جزء من الفترة قبل تفعيل التكلفة (${new Date(cfg.startedAt).toISOString().slice(0, 10)}) — مبيعاته بلا تكلفة.` });
  if (T.uncostedLines) w.push({ level: 'warn', text: `${T.uncostedLines} سطر مبيع بلا وصفة (${r3(T.uncostedRevenue)} دينار) — تكلفة المبيعات ومجمل الربح ناقصان.`, drill: { type: 'saleCosts', missing: true } });
  if (labor.missing.length) w.push({ level: 'warn', text: `موظفون بلا راتب ولا أجر ساعة: ${labor.missing.join('، ')} — عمالتهم محسوبة صفراً.` });
  if (T.allocBasis === 'missing') w.push({ level: 'warn', text: 'بند تكلفة بلا بيانات (فاتورة أو عمر إهلاك) — راجع البنود الموزّعة.' });
  return w;
}

/** فترة المقارنة: يوم واحد ← نفس اليوم من الأسبوع الماضي، وإلا الفترة السابقة بنفس الطول. */
function comparableRange(from, to) {
  const n = daysBetween(from, to).length;
  if (n === 1) return { from: addDays(from, -7), to: addDays(to, -7), label: 'نفس اليوم الأسبوع الماضي' };
  return { from: addDays(from, -n), to: addDays(from, -1), label: `الـ ${n} يوماً السابقة` };
}

/** تفسير التغيّر من الأرقام فقط: أكبر ثلاثة مساهمين في فرق الربح التشغيلي. */
function explainChange(cur, prev, label) {
  const a = cur.kpi; const b = prev.kpi;
  if (!b.netSales && !b.operatingProfit) return { text: `لا توجد بيانات كافية في ${label} للمقارنة.`, drivers: [] };
  const drivers = [
    { k: 'netSales', label: 'صافي المبيعات', impact: a.netSales - b.netSales, sign: 1 },
    { k: 'cogs', label: 'تكلفة المواد', impact: -(a.cogs - b.cogs), sign: -1 },
    { k: 'labor', label: 'العمالة', impact: -(a.labor - b.labor), sign: -1 },
    { k: 'waste', label: 'الهدر والتالف', impact: -(a.waste - b.waste), sign: -1 },
    { k: 'shrinkage', label: 'عجز الجرد', impact: -(a.shrinkage - b.shrinkage), sign: -1 },
    { k: 'opex', label: 'المصاريف التشغيلية', impact: -(a.opex - b.opex), sign: -1 },
    { k: 'allocated', label: 'البنود الموزّعة', impact: -(a.allocated - b.allocated), sign: -1 },
  ].filter((d) => Math.abs(d.impact) >= 0.005).sort((x, y) => Math.abs(y.impact) - Math.abs(x.impact)).slice(0, 3);
  const diff = a.operatingProfit - b.operatingProfit;
  // النسبة مضلّلة إن كان ربح المقارنة صغيراً جداً (أقل من 5% من مبيعاته أو دينار واحد) — نذكر الفرق بالدينار فقط
  const meaningful = b.netSales > 0 && Math.abs(b.operatingProfit) >= Math.max(1, 0.05 * b.netSales);
  const pct = meaningful ? (diff / Math.abs(b.operatingProfit)) * 100 : null;
  const verb = diff >= 0 ? 'ارتفع' : 'انخفض';
  const why = drivers.map((d) => {
    const up = d.sign === 1 ? d.impact > 0 : d.impact < 0; // هل ارتفع البند نفسه
    return `${up ? 'ارتفاع' : 'انخفاض'} ${d.label} (${d.impact >= 0 ? '+' : '−'}${r3(Math.abs(d.impact))})`;
  });
  return {
    text: `${verb} الربح التشغيلي ${r3(Math.abs(diff))} دينار${pct != null ? ` (${r3(Math.abs(pct))}%)` : ''} مقارنة بـ${label}${why.length ? ` — بسبب ${why.join('، و')}` : ''}.`,
    diff: r3(diff), pct: pct != null ? r3(pct) : null, drivers: drivers.map((d) => ({ ...d, impact: r3(d.impact) })),
  };
}

module.exports = { compute, comparableRange, explainChange, r3 };
