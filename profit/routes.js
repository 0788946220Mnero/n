/**
 * /api/profit — إدارة المطعم والربحية.
 *   profit:view       القراءة: اللوحة، قائمة الدخل، الأصناف، القنوات، التعادل، المحاكاة، التتبع
 *   profit:manage     الوصفات، المواد، البنود الموزّعة، أجور الساعة، اعتماد الجرد، الإعدادات
 *   inventory:operate الاستلام، الهدر، وجبات الموظفين، دفعات التحضير، إدخال الجرد
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { logActivity } = require('../utils/activity');
const ProfitConfig = require('./models/ProfitConfig');
const Ingredient = require('./models/Ingredient');
const Recipe = require('./models/Recipe');
const StockReceipt = require('./models/StockReceipt');
const StockCount = require('./models/StockCount');
const InternalUse = require('./models/InternalUse');
const CostItem = require('./models/CostItem');
const Product = require('../models/Product');
const Employee = require('../models/Employee');
const ShiftSession = require('../models/ShiftSession');
const AttendanceShift = require('../models/AttendanceShift');
const inv = require('./services/inventory');
const cons = require('./services/consumption');
const A = require('./services/analysis');
const { compute } = require('./services/pnl');
const { productCard, makeCtx } = require('./services/costing');
const { getConfig, invalidate } = require('./services/config');
const { businessDay, isDay, addDays, daysBetween } = require('./services/time');

const view = requirePermission('profit:view', 'profit:manage');
const manage = requirePermission('profit:manage');
const operate = requirePermission('inventory:operate', 'profit:manage');
const seeStock = requirePermission('inventory:operate', 'profit:manage', 'profit:view');
const isId = (v) => mongoose.isValidObjectId(v);
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) {
    const status = e.status || (e.name === 'ValidationError' ? 400 : 500);
    if (status >= 500) console.error('profit:', e);
    res.status(status).json({ success: false, message: status >= 500 ? 'تعذّر تنفيذ العملية' : e.message, error: status >= 500 ? e.message : undefined });
  }
};
const audit = (req, action, details) => logActivity({ req, action: `profit.${action}`, details });
async function rangeQ(q) {
  const cfg = await getConfig();
  const today = businessDay(new Date(), cfg.dayStartHour);
  const to = isDay(q.to) ? q.to : today; const from = isDay(q.from) ? q.from : to;
  if (from > to) throw Object.assign(new Error('بداية الفترة بعد نهايتها'), { status: 400 });
  if (daysBetween(from, to).length > 370) throw Object.assign(new Error('الفترة أطول من سنة'), { status: 400 });
  return { from, to, today };
}
// الترحيل قبل القراءة: الأرقام لا تتأخر عن آخر بيع (ودورة الدقيقة تكمل الباقي)
const fresh = () => cons.runOnce(500).catch((e) => console.error('profit fresh:', e.message));

/* ═════════ الإعدادات ═════════ */
router.get('/config', protect, view, wrap(async () => getConfig(true)));
router.put('/config', protect, manage, wrap(async (req) => {
  const b = req.body || {}; const set = {};
  const nums = { dayStartHour: [0, 12], workDaysPerMonth: [1, 31], defaultShiftHours: [1, 16], overtimeMultiplier: [1, 3], lowMarginPct: [0, 100], targetFoodCostPct: [0, 100], wasteAlertPct: [0, 100], priceRiseAlertPct: [0, 500] };
  for (const [k, [lo, hi]] of Object.entries(nums)) if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= lo && v <= hi)) throw Object.assign(new Error(`قيمة ${k} خارج المدى`), { status: 400 }); set[k] = v; }
  if (b.includeDeliveryFeeInRevenue !== undefined) set.includeDeliveryFeeInRevenue = b.includeDeliveryFeeInRevenue === true;
  if (Array.isArray(b.inventoryExpenseCategories)) set.inventoryExpenseCategories = [...new Set(b.inventoryExpenseCategories.map((x) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  const cur = await getConfig(true);
  if (b.enabled !== undefined) {
    set.enabled = b.enabled === true;
    if (set.enabled && !cur.startedAt) set.startedAt = new Date(); // التكلفة تبدأ من لحظة التفعيل
  }
  if (b.startedAt !== undefined && req.user.role === 'admin') {
    const d = new Date(b.startedAt);
    if (Number.isNaN(d.getTime()) || d > new Date()) throw Object.assign(new Error('تاريخ بدء التكلفة غير صحيح'), { status: 400 });
    set.startedAt = d;
  }
  const doc = await ProfitConfig.findOneAndUpdate({ key: 'main' }, { $set: set, $inc: { rev: 1 } }, { upsert: true, new: true }).lean();
  invalidate(); audit(req, 'config', set);
  if (set.enabled) fresh();
  return doc;
}));
router.post('/run', protect, manage, wrap(async () => cons.runOnce(2000)));

/* ═════════ اللوحة الحية ═════════ */
router.get('/dashboard', protect, view, wrap(async () => {
  await fresh();
  const cfg = await getConfig();
  const today = businessDay(new Date(), cfg.dayStartHour);
  const [day, be, open, onShift] = await Promise.all([
    A.report(today, today), A.breakEven(today),
    ShiftSession.find({ status: 'open' }).select('shiftId userName scope openedAt openedByName').lean(),
    AttendanceShift.countDocuments({ status: 'open' }),
  ]);
  const consumption = await require('./models/StockMovement').find({ businessDay: today, type: { $in: ['sale', 'staff_meal', 'product_waste', 'prep_out'] } }).select('value').lean();
  return { today, ...day, breakEven: be, openShifts: open, staffOnShift: onShift, consumptionValue: Math.round(-consumption.reduce((s, m) => s + m.value, 0) * 1000) / 1000 };
}));

/* ═════════ التقارير ═════════ */
router.get('/report', protect, view, wrap(async (req) => { await fresh(); const { from, to } = await rangeQ(req.query); return A.report(from, to); }));
router.get('/products', protect, view, wrap(async (req) => { const { from, to } = await rangeQ(req.query); return A.products(from, to); }));
router.get('/categories', protect, view, wrap(async (req) => { const { from, to } = await rangeQ(req.query); return A.categories(from, to); }));
router.get('/channels', protect, view, wrap(async (req) => { const { from, to } = await rangeQ(req.query); return A.channels(from, to); }));
router.get('/break-even', protect, view, wrap(async () => A.breakEven()));
router.get('/forecast', protect, view, wrap(async () => A.forecastMonth()));
router.get('/insights', protect, view, wrap(async () => A.insights()));
router.post('/simulate', protect, view, wrap(async (req) => A.simulate(req.body || {})));
router.get('/drill', protect, view, wrap(async (req) => { const q = { ...req.query }; if (!q.start) Object.assign(q, await rangeQ(req.query)); return A.drill(q); }));
router.get('/shifts', protect, view, wrap(async () => ShiftSession.find().sort({ openedAt: -1 }).limit(60).select('shiftId userName scope status openedAt closedAt cashDiff salesTotal').lean()));
router.get('/shifts/:shiftId', protect, view, wrap(async (req) => { await fresh(); return A.shiftReport(req.params.shiftId); }));
router.get('/export', protect, view, async (req, res) => {
  try {
    const { from, to } = await rangeQ(req.query);
    const type = req.query.type || 'statement';
    let rows; let head;
    if (type === 'products') { const p = await A.products(from, to); head = ['الصنف', 'الكمية', 'صافي الإيراد', 'التكلفة', 'مجمل الربح', 'الهامش %', 'نسبة التكلفة %', 'بلا وصفة']; rows = p.rows.map((r) => [r.name, r.qty, r.netRevenue, r.cost, r.grossProfit, r.marginPct, r.foodCostPct, r.uncostedQty]); }
    else if (type === 'daily') { const c = await compute({ from, to }); head = ['اليوم', 'الطلبات', 'صافي المبيعات', 'تكلفة المبيعات', 'مجمل الربح', 'العمالة', 'الموزّع', 'المصاريف', 'الهدر', 'الربح التشغيلي']; rows = c.series.map((d) => [d.day, d.orders, d.netSales, d.cogs, d.grossProfit, d.labor, d.allocated, d.opex, d.waste, d.operatingProfit]); }
    else { const c = await compute({ from, to }); head = ['البند', 'المبلغ', 'التصنيف', 'المعادلة']; rows = c.statement.lines.map((l) => [l.label, l.amount, l.basis, l.formula]); }
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="profit-${type}-${from}_${to}.csv"`);
    res.send(csv);
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

/* ═════════ المواد والوصفات ═════════ */
router.get('/ingredients', protect, seeStock, wrap(async () => inv.valuation()));
router.post('/ingredients', protect, manage, wrap(async (req) => { const d = await inv.createIngredient(req.body || {}); audit(req, 'ingredient.create', { name: d.name }); return d; }));
router.put('/ingredients/:id', protect, manage, wrap(async (req) => { const d = await inv.updateIngredient(req.params.id, req.body || {}); audit(req, 'ingredient.update', { id: req.params.id, fields: Object.keys(req.body || {}) }); return d; }));
router.get('/ingredients/:id/history', protect, seeStock, wrap(async (req) => { if (!isId(req.params.id)) throw Object.assign(new Error('معرّف غير صالح'), { status: 400 }); return inv.priceHistory(req.params.id); }));

router.get('/product-cards', protect, view, wrap(async () => {
  const prods = await Product.find().select('nameAr price category addons isAvailable').sort({ order: 1, nameAr: 1 }).lean();
  const ctx = makeCtx(); const out = [];
  for (const p of prods) out.push({ ...(await productCard(p, ctx)), category: p.category, addons: (p.addons || []).map((a) => a.name), isAvailable: p.isAvailable });
  return out;
}));
router.get('/recipes/:type/:id', protect, seeStock, wrap(async (req) => {
  if (!['product', 'prep'].includes(req.params.type) || !isId(req.params.id)) throw Object.assign(new Error('طلب غير صالح'), { status: 400 });
  return Recipe.find({ targetType: req.params.type, target: req.params.id }).sort({ version: -1 }).limit(30).lean();
}));
router.post('/recipes', protect, manage, wrap(async (req) => {
  const d = await inv.saveRecipe({ ...(req.body || {}), byName: req.user.name });
  audit(req, 'recipe.save', { target: d.targetName, version: d.version, lines: d.lines.length });
  return d;
}));

/* ═════════ عمليات المخزون ═════════ */
router.get('/receipts', protect, seeStock, wrap(async () => StockReceipt.find().sort({ receivedAt: -1 }).limit(100).lean()));
router.post('/receipts', protect, operate, wrap(async (req) => { const r = await inv.createReceipt(req.body || {}, req.user); if (!r.duplicate) audit(req, 'receipt', { number: r.receipt.number, total: r.receipt.total }); return r; }));
router.post('/movements', protect, operate, wrap(async (req) => {
  const b = req.body || {};
  if (['adjust', 'opening'].includes(b.type) && !require('../middlewares/permission').hasPermission(req.user, 'profit:manage')) throw Object.assign(new Error('تعديل الرصيد والرصيد الافتتاحي لمدير الربحية'), { status: 403 });
  const r = await inv.ingredientMovement(b, req.user); audit(req, `stock.${b.type}`, { ingredient: b.ingredient, qty: b.qty, unit: b.unit, reason: b.reason }); return r;
}));
router.post('/batches', protect, operate, wrap(async (req) => { const r = await inv.produceBatch(req.body || {}, req.user); audit(req, 'batch', { prep: req.body && req.body.prep, batches: req.body && req.body.batches }); return r; }));
router.get('/internal', protect, seeStock, wrap(async () => InternalUse.find().sort({ at: -1 }).limit(100).lean()));
router.post('/internal', protect, operate, wrap(async (req) => { const r = await inv.internalUse(req.body || {}, req.user); if (!r.duplicate) audit(req, r.doc.kind, { cost: r.doc.cost, employee: r.doc.employeeName }); return r; }));
router.get('/counts', protect, seeStock, wrap(async () => StockCount.find().sort({ countedAt: -1 }).limit(60).lean()));
router.post('/counts', protect, operate, wrap(async (req) => inv.createCount(req.body || {}, req.user)));
router.post('/counts/:id/post', protect, manage, wrap(async (req) => { if (!isId(req.params.id)) throw Object.assign(new Error('معرّف غير صالح'), { status: 400 }); const r = await inv.postCount(req.params.id, req.user); audit(req, 'count.post', { number: r.number, shortage: r.shortageValue, surplus: r.surplusValue }); return r; }));
router.get('/usage', protect, seeStock, wrap(async (req) => { const { from, to } = await rangeQ(req.query); const cfg = await getConfig(); const { dayRange } = require('./services/time'); return inv.usageReport(dayRange(from, cfg.dayStartHour).start, dayRange(to, cfg.dayStartHour).end); }));

/* ═════════ البنود الموزّعة ═════════ */
function cleanCostItem(b) {
  const o = {};
  if (b.name !== undefined) { o.name = String(b.name || '').trim().slice(0, 80); if (!o.name) throw Object.assign(new Error('اسم البند مطلوب'), { status: 400 }); }
  for (const k of ['category', 'method', 'percentBase', 'notes']) if (b[k] !== undefined) o[k] = String(b[k]);
  for (const k of ['amount', 'percent', 'assetCost', 'salvage', 'lifeMonths']) if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= 0)) throw Object.assign(new Error(`قيمة ${k} غير صحيحة`), { status: 400 }); o[k] = v; }
  for (const k of ['startDate', 'endDate']) if (b[k] !== undefined) { if (b[k] && !isDay(b[k])) throw Object.assign(new Error('صيغة التاريخ YYYY-MM-DD'), { status: 400 }); o[k] = b[k] || ''; }
  if (b.active !== undefined) o.active = b.active !== false;
  if (b.obligation !== undefined) o.obligation = isId(b.obligation) ? b.obligation : null;
  return o;
}
router.get('/cost-items', protect, view, wrap(async () => CostItem.find().sort({ active: -1, category: 1, name: 1 }).lean()));
router.post('/cost-items', protect, manage, wrap(async (req) => {
  const o = cleanCostItem(req.body || {});
  if (!o.startDate) o.startDate = businessDay(new Date(), (await getConfig()).dayStartHour);
  const d = await CostItem.create({ ...o, byName: req.user.name }); audit(req, 'costItem.create', { name: d.name, method: d.method }); return d;
}));
router.put('/cost-items/:id', protect, manage, wrap(async (req) => {
  if (!isId(req.params.id)) throw Object.assign(new Error('معرّف غير صالح'), { status: 400 });
  const d = await CostItem.findOneAndUpdate({ _id: req.params.id }, { $set: cleanCostItem(req.body || {}) }, { new: true, runValidators: true }).lean();
  if (!d) throw Object.assign(new Error('البند غير موجود'), { status: 404 });
  audit(req, 'costItem.update', { id: req.params.id, fields: Object.keys(req.body || {}) }); return d;
}));
router.post('/cost-items/:id/bills', protect, manage, wrap(async (req) => {
  const b = req.body || {};
  if (!isDay(b.from) || !isDay(b.to) || b.from > b.to) throw Object.assign(new Error('فترة الفاتورة غير صحيحة'), { status: 400 });
  const amount = Number(b.amount); if (!(amount >= 0)) throw Object.assign(new Error('مبلغ الفاتورة غير صحيح'), { status: 400 });
  const d = await CostItem.findOneAndUpdate({ _id: req.params.id, method: 'bills' }, { $push: { bills: { from: b.from, to: b.to, amount, note: String(b.note || '').slice(0, 120), addedByName: req.user.name } } }, { new: true }).lean();
  if (!d) throw Object.assign(new Error('البند غير موجود أو ليس بفواتير'), { status: 404 });
  audit(req, 'costItem.bill', { name: d.name, from: b.from, to: b.to, amount }); return d;
}));
router.post('/cost-items/import-obligations', protect, manage, wrap(async (req) => {
  const FixedObligation = require('../models/FixedObligation');
  const obs = await FixedObligation.find({ active: true, archived: { $ne: true }, recurrence: 'monthly' }).lean();
  const have = new Set((await CostItem.find({ obligation: { $ne: null } }).select('obligation').lean()).map((c) => String(c.obligation)));
  const start = businessDay(new Date(), (await getConfig()).dayStartHour);
  const made = [];
  for (const ob of obs) {
    if (have.has(String(ob._id))) continue;
    made.push(await CostItem.create({ name: ob.name, category: /إيجار/.test(ob.name) ? 'rent' : 'subscription', method: 'monthly', amount: ob.amount, startDate: start, obligation: ob._id, byName: req.user.name, notes: `مستورد من الالتزام ${ob.number || ''}` }));
  }
  audit(req, 'costItem.import', { count: made.length });
  return { imported: made.length, items: made };
}));

// أسماء الموظفين فقط (لوجبة الموظف) — بلا رواتب
router.get('/staff', protect, operate, wrap(async () => Employee.find({ active: { $ne: false } }).select('name section').sort({ name: 1 }).lean()));

/* ═════════ أجور الساعة ═════════ */
router.get('/employees', protect, manage, wrap(async () => {
  const cfg = await getConfig(); const { rateOf } = require('./services/labor');
  return (await Employee.find({ active: { $ne: false } }).select('name section salary hourlyRate shiftHours').sort({ name: 1 }).lean()).map((e) => ({ ...e, effective: rateOf(e, cfg) }));
}));
router.put('/employees/:id/rate', protect, manage, wrap(async (req) => {
  if (!isId(req.params.id)) throw Object.assign(new Error('معرّف غير صالح'), { status: 400 });
  const v = req.body && req.body.hourlyRate; const rate = v === '' || v == null ? null : Number(v);
  if (rate != null && !(rate >= 0 && rate <= 100)) throw Object.assign(new Error('أجر الساعة غير صحيح'), { status: 400 });
  const d = await Employee.findOneAndUpdate({ _id: req.params.id }, { $set: { hourlyRate: rate } }, { new: true }).select('name hourlyRate').lean();
  if (!d) throw Object.assign(new Error('الموظف غير موجود'), { status: 404 });
  audit(req, 'employee.rate', { name: d.name, hourlyRate: rate }); return d;
}));

module.exports = router;
module.exports._addDays = addDays;
