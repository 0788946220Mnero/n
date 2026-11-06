/**
 * عمليات المخزون والوصفات — كل تغيير على الرصيد يمرّ بدفتر الحركات (لا طرح مباشر أبداً).
 */
const mongoose = require('mongoose');
const Ingredient = require('../models/Ingredient');
const Recipe = require('../models/Recipe');
const StockMovement = require('../models/StockMovement');
const StockReceipt = require('../models/StockReceipt');
const StockCount = require('../models/StockCount');
const InternalUse = require('../models/InternalUse');
const SaleCost = require('../models/SaleCost');
const Product = require('../../models/Product');
const Counter = require('../../models/Counter');
const ledger = require('./ledger');
const { factorFor, UnitError } = require('./units');
const { costLine, makeCtx, prepUnitCost, r3, r6 } = require('./costing');
const { businessDay } = require('./time');
const { getConfig } = require('./config');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const isId = (v) => mongoose.isValidObjectId(v);
const num = (v) => (v === '' || v == null ? NaN : Number(v));
async function nextNo(name) {
  const c = await Counter.findOneAndUpdate({ _id: `profit:${name}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c.seq;
}
const dayOf = async (at) => businessDay(at, (await getConfig()).dayStartHour);

/* ═════════ المواد ═════════ */
function cleanIngredient(b, partial = false) {
  const o = {};
  if (!partial || b.name !== undefined) { o.name = String(b.name || '').trim().slice(0, 80); if (!o.name) throw bad('اسم المادة مطلوب'); }
  if (!partial || b.baseUnit !== undefined) { if (!['g', 'ml', 'pc'].includes(b.baseUnit)) throw bad('الوحدة الأساسية: g أو ml أو pc'); o.baseUnit = b.baseUnit; }
  if (b.category !== undefined) o.category = ['food', 'packaging', 'cleaning', 'other'].includes(b.category) ? b.category : 'food';
  if (b.kind !== undefined) o.kind = b.kind === 'prep' ? 'prep' : 'raw';
  if (b.trackMode !== undefined) o.trackMode = b.trackMode === 'explode' ? 'explode' : 'stock';
  if (b.wastePct !== undefined) { const w = num(b.wastePct); if (!(w >= 0 && w <= 90)) throw bad('نسبة الهدر بين 0 و 90'); o.wastePct = w; }
  if (b.minStock !== undefined) o.minStock = Math.max(0, num(b.minStock) || 0);
  if (b.supplier !== undefined) o.supplier = String(b.supplier || '').trim().slice(0, 80);
  if (b.notes !== undefined) o.notes = String(b.notes || '').slice(0, 300);
  if (b.active !== undefined) o.active = b.active !== false;
  if (b.purchaseUnits !== undefined) {
    if (!Array.isArray(b.purchaseUnits)) throw bad('وحدات الشراء قائمة');
    o.purchaseUnits = b.purchaseUnits.slice(0, 10).map((p) => {
      const name = String(p.name || '').trim().slice(0, 30); const factor = num(p.factor);
      if (!name || !(factor > 0)) throw bad('كل وحدة شراء تحتاج اسماً ومعاملاً موجباً');
      return { name, factor };
    });
  }
  return o;
}
async function createIngredient(b) {
  const o = cleanIngredient(b);
  try { return await Ingredient.create(o); } catch (e) { if (e && e.code === 11000) throw bad('توجد مادة بنفس الاسم', 409); throw e; }
}
async function updateIngredient(id, b) {
  if (!isId(id)) throw bad('معرّف غير صالح');
  const ing = await Ingredient.findById(id).lean();
  if (!ing) throw bad('المادة غير موجودة', 404);
  const o = cleanIngredient(b, true);
  // تغيير الوحدة الأساسية بعد وجود حركات يُفسد كل الكميات التاريخية
  if (o.baseUnit && o.baseUnit !== ing.baseUnit && await StockMovement.exists({ ingredient: id })) throw bad('لا يمكن تغيير الوحدة الأساسية لمادة لها حركات — أنشئ مادة جديدة', 409);
  return Ingredient.findOneAndUpdate({ _id: id }, { $set: o }, { new: true }).lean();
}

/* ═════════ الوصفات (بنسخ) ═════════ */
async function cleanLines(lines, label) {
  if (!Array.isArray(lines)) return [];
  const ids = lines.map((l) => l.ingredient).filter(isId);
  const ings = new Map((await Ingredient.find({ _id: { $in: ids } }).lean()).map((i) => [String(i._id), i]));
  return lines.slice(0, 60).map((l, idx) => {
    const ing = ings.get(String(l.ingredient));
    if (!ing) throw bad(`${label}: السطر ${idx + 1} بلا مادة صحيحة`);
    const qty = num(l.qty);
    if (!Number.isFinite(qty) || qty === 0) throw bad(`${label}: كمية «${ing.name}» غير صحيحة`);
    const unit = String(l.unit || ing.baseUnit).trim();
    try { factorFor(ing, unit); } catch (e) { if (e instanceof UnitError) throw bad(e.message); throw e; }
    const wastePct = l.wastePct === '' || l.wastePct == null ? null : num(l.wastePct);
    if (wastePct != null && !(wastePct >= 0 && wastePct <= 90)) throw bad('نسبة الهدر بين 0 و 90');
    return { ingredient: ing._id, qty, unit, wastePct, role: l.role === 'packaging' || ing.category === 'packaging' ? 'packaging' : 'material' };
  });
}

/** يحفظ نسخة جديدة ويُنهي السابقة (لا يعدّل نسخة قديمة أبداً). */
async function saveRecipe({ targetType, target, lines, addonLines, yieldQty, notes, byName }) {
  if (!['product', 'prep'].includes(targetType) || !isId(target)) throw bad('هدف الوصفة غير صالح');
  let targetName = '';
  if (targetType === 'product') {
    const p = await Product.findById(target).select('nameAr').lean(); if (!p) throw bad('الصنف غير موجود', 404); targetName = p.nameAr;
  } else {
    const i = await Ingredient.findById(target).lean(); if (!i || i.kind !== 'prep') throw bad('التحضير غير موجود', 404); targetName = i.name;
  }
  const clean = await cleanLines(lines, 'الوصفة');
  if (!clean.length) throw bad('الوصفة تحتاج مكوّناً واحداً على الأقل');
  if (targetType === 'prep' && clean.some((l) => String(l.ingredient) === String(target))) throw bad('التحضير لا يدخل في وصفته نفسها');
  const addons = [];
  for (const a of (Array.isArray(addonLines) ? addonLines : []).slice(0, 30)) {
    const name = String(a.addonName || '').trim().slice(0, 60);
    if (!name) continue;
    addons.push({ addonName: name, lines: await cleanLines(a.lines, `الإضافة «${name}»`) });
  }
  const now = new Date();
  const prev = await Recipe.findOne({ targetType, target, current: true }).lean();
  const last = await Recipe.find({ targetType, target }).sort({ version: -1 }).limit(1).lean();
  const version = (last[0] ? last[0].version : 0) + 1;
  const doc = await Recipe.create({
    targetType, target, targetName, version, current: true, effectiveFrom: now,
    yieldQty: targetType === 'prep' ? Math.max(0.000001, num(yieldQty) || 1) : 1,
    lines: clean, addonLines: addons, notes: String(notes || '').slice(0, 300), createdByName: byName || '',
  });
  if (prev) await Recipe.updateOne({ _id: prev._id }, { $set: { current: false, effectiveTo: now } });
  return doc.toObject ? doc.toObject() : doc;
}

/* ═════════ الاستلام (فاتورة مورّد) ═════════ */
async function createReceipt(b, user) {
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('أضف مادة واحدة على الأقل');
  if (b.clientRef) { const ex = await StockReceipt.findOne({ clientRef: String(b.clientRef) }).lean(); if (ex) return { receipt: ex, duplicate: true }; }
  const at = b.receivedAt ? new Date(b.receivedAt) : new Date();
  if (Number.isNaN(at.getTime()) || at > new Date(Date.now() + 5 * 60000)) throw bad('تاريخ الاستلام غير صحيح');
  const ids = b.lines.map((l) => l.ingredient).filter(isId);
  const ings = new Map((await Ingredient.find({ _id: { $in: ids } }).lean()).map((i) => [String(i._id), i]));
  const lines = b.lines.slice(0, 80).map((l, idx) => {
    const ing = ings.get(String(l.ingredient));
    if (!ing) throw bad(`السطر ${idx + 1}: مادة غير صحيحة`);
    if (ing.kind === 'prep' && ing.trackMode === 'explode') throw bad(`«${ing.name}» تحضير بلا رصيد — لا يُستلم`);
    const qty = num(l.qty); const unitPrice = num(l.unitPrice);
    if (!(qty > 0)) throw bad(`كمية «${ing.name}» غير صحيحة`);
    if (!(unitPrice >= 0)) throw bad(`سعر «${ing.name}» غير صحيح`);
    let factor; try { factor = factorFor(ing, l.unit || ing.baseUnit); } catch (e) { throw bad(e.message); }
    const total = r6(num(l.total) > 0 ? num(l.total) : qty * unitPrice);
    const baseQty = r6(qty * factor);
    return { ingredient: ing._id, ingredientName: ing.name, qty, unit: String(l.unit || ing.baseUnit), factor, unitPrice: r6(total / qty), total, baseQty, baseCost: r6(total / baseQty) };
  });
  const day = await dayOf(at);
  const receipt = await StockReceipt.create({
    number: await nextNo('receipt'), clientRef: b.clientRef ? String(b.clientRef) : null,
    supplier: String(b.supplier || '').trim().slice(0, 80), invoiceNumber: String(b.invoiceNumber || '').trim().slice(0, 40),
    receivable: isId(b.receivable) ? b.receivable : null, lines, total: r3(lines.reduce((s, l) => s + l.total, 0)),
    receivedAt: at, businessDay: day, notes: String(b.notes || '').slice(0, 300), byName: (user && user.name) || '', by: user ? user._id : null,
  });
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k];
    await ledger.receive({ key: `receipt:${receipt._id}:${k}`, ingredient: l.ingredient, qty: l.baseQty, unitCost: l.baseCost, at, businessDay: day, refType: 'receipt', refId: String(receipt._id), byName: receipt.byName, reason: `استلام ${receipt.number}${receipt.supplier ? ` — ${receipt.supplier}` : ''}` });
  }
  return { receipt: receipt.toObject ? receipt.toObject() : receipt, duplicate: false };
}

/* ═════════ هدر / تالف / تعديل على مادة ═════════ */
async function ingredientMovement(b, user) {
  const type = ['waste', 'expired', 'adjust', 'opening'].includes(b.type) ? b.type : null;
  if (!type) throw bad('نوع الحركة غير صالح');
  const ing = isId(b.ingredient) ? await Ingredient.findById(b.ingredient).lean() : null;
  if (!ing) throw bad('المادة غير موجودة', 404);
  let factor; try { factor = factorFor(ing, b.unit || ing.baseUnit); } catch (e) { throw bad(e.message); }
  let qty = num(b.qty) * factor;
  if (!Number.isFinite(qty) || qty === 0) throw bad('الكمية غير صحيحة');
  if (type === 'waste' || type === 'expired') qty = -Math.abs(qty);
  const reason = String(b.reason || '').trim().slice(0, 200);
  if ((type === 'adjust' || type === 'waste' || type === 'expired') && !reason) throw bad('اكتب السبب — كل تعديل على المخزون يُراجع');
  const at = new Date();
  const ref = String(b.clientRef || new mongoose.Types.ObjectId());
  if (type === 'opening') {
    const unitCost = num(b.unitCost) / factor; // السعر المُدخل لكل وحدة مختارة (كغ مثلاً) ← لكل وحدة أساس
    if (!(unitCost >= 0)) throw bad('أدخل تكلفة الوحدة للرصيد الافتتاحي');
    return ledger.receive({ key: `opening:${ref}`, ingredient: ing._id, qty: Math.abs(qty), unitCost, at, businessDay: await dayOf(at), refType: 'manual', refId: ref, byName: user && user.name, reason: reason || 'رصيد افتتاحي' });
  }
  return ledger.post({ key: `${type}:${ref}`, ingredient: ing._id, ingredientName: ing.name, type, qty, unitCost: ing.avgCost || 0, at, businessDay: await dayOf(at), refType: 'manual', refId: ref, byName: (user && user.name) || '', reason });
}

/* ═════════ إنتاج دفعة تحضير (صلصة، تتبيلة) ═════════ */
async function produceBatch(b, user) {
  const prep = isId(b.prep) ? await Ingredient.findById(b.prep).lean() : null;
  if (!prep || prep.kind !== 'prep' || prep.trackMode !== 'stock') throw bad('اختر تحضيراً يُنتج بدفعات');
  const ctx = makeCtx();
  const { recipeAt } = require('./costing');
  const rec = await recipeAt('prep', prep._id, null);
  if (!rec) throw bad('للتحضير وصفة أولاً');
  const batches = num(b.batches) || 1;
  if (!(batches > 0 && batches <= 100)) throw bad('عدد الدفعات غير صحيح');
  const outQty = r6(rec.yieldQty * batches);
  const ref = String(b.clientRef || new mongoose.Types.ObjectId());
  if (await StockMovement.exists({ key: `batch:${ref}:in` })) return { duplicate: true };
  const at = new Date(); const day = await dayOf(at);
  // المكوّنات بنسب الوصفة (وتحضيرات explode تُفكّ لخامها)
  const comps = [];
  const meta = { missing: [], noCost: [], asOf: null };
  await require('./costing').__explode(ctx, rec.lines, batches, comps, meta);
  let total = 0;
  for (let k = 0; k < comps.length; k += 1) {
    const c = comps[k]; total += c.cost;
    await ledger.post({ key: `batch:${ref}:out:${k}`, ingredient: c.deductFrom, ingredientName: c.name, type: 'prep_out', qty: -c.qty, unitCost: c.unitCost, at, businessDay: day, refType: 'batch', refId: ref, byName: user && user.name, reason: `إنتاج ${prep.name}` });
  }
  await ledger.receive({ key: `batch:${ref}:in`, ingredient: prep._id, qty: outQty, unitCost: outQty ? r6(total / outQty) : 0, at, businessDay: day, refType: 'batch', refId: ref, byName: user && user.name, reason: `إنتاج ${batches} دفعة` });
  return { produced: outQty, cost: r3(total), unitCost: outQty ? r6(total / outQty) : 0 };
}

/* ═════════ وجبة موظف / صنف تالف ═════════ */
async function internalUse(b, user) {
  const kind = b.kind === 'product_waste' ? 'product_waste' : 'staff_meal';
  if (b.clientRef) { const ex = await InternalUse.findOne({ clientRef: String(b.clientRef) }).lean(); if (ex) return { doc: ex, duplicate: true }; }
  if (!Array.isArray(b.items) || !b.items.length) throw bad('اختر صنفاً واحداً على الأقل');
  const prods = new Map((await Product.find({ _id: { $in: b.items.map((i) => i.product).filter(isId) } }).select('nameAr category').lean()).map((p) => [String(p._id), p]));
  const items = b.items.slice(0, 30).map((i) => {
    const p = prods.get(String(i.product)); if (!p) throw bad('صنف غير صحيح');
    const qty = num(i.qty) || 1; if (!(qty > 0 && qty <= 100)) throw bad('كمية غير صحيحة');
    return { product: p._id, productName: p.nameAr, qty, addons: (i.addons || []).map((a) => ({ name: String(a.name || a) })) };
  });
  let employee = null; let employeeName = '';
  if (kind === 'staff_meal') {
    const Employee = require('../../models/Employee');
    const e = isId(b.employee) ? await Employee.findById(b.employee).select('name').lean() : null;
    if (!e) throw bad('اختر الموظف صاحب الوجبة');
    employee = e._id; employeeName = e.name;
  }
  const reason = String(b.reason || '').trim().slice(0, 200);
  if (kind === 'product_waste' && !reason) throw bad('اكتب سبب التلف');
  const at = new Date(); const day = await dayOf(at);
  const doc = await InternalUse.create({ kind, clientRef: b.clientRef ? String(b.clientRef) : null, employee, employeeName, items, reason, at, businessDay: day, byName: (user && user.name) || '' });
  const ctx = makeCtx(); let total = 0;
  const tag = kind === 'staff_meal' ? 'meal' : 'pwaste';
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]; const key = `${tag}:${doc._id}:${i}`;
    const c = await costLine({ product: it.product, qty: it.qty, addons: it.addons, ctx });
    for (let k = 0; k < c.components.length; k += 1) {
      const comp = c.components[k];
      await ledger.post({ key: `${key}:${k}`, ingredient: comp.deductFrom, ingredientName: comp.name, type: kind, qty: -comp.qty, unitCost: comp.unitCost, at, businessDay: day, refType: tag, refId: String(doc._id), byName: doc.byName, reason: `${kind === 'staff_meal' ? 'وجبة' : 'تالف'} ${it.productName}${employeeName ? ` — ${employeeName}` : ''}` });
    }
    total += c.cost;
    await SaleCost.create({ key, kind, product: it.product, productName: it.productName, category: (prods.get(String(it.product)) || {}).category || null, qty: it.qty, revenue: 0,
      recipe: c.recipe ? c.recipe._id : null, recipeVersion: c.recipe ? c.recipe.version : null, material: c.material, packaging: c.packaging, cost: c.cost,
      missingRecipe: c.missingRecipe, missingCost: !!c.missingCost, components: c.components.map(({ deductFrom, ...x }) => x), at, businessDay: day, employee, employeeName,
    }).catch((e) => { if (!(e && e.code === 11000)) throw e; });
  }
  await InternalUse.updateOne({ _id: doc._id }, { $set: { cost: r3(total) } });
  return { doc: { ...(doc.toObject ? doc.toObject() : doc), cost: r3(total) }, duplicate: false };
}

/* ═════════ الجرد الفعلي ═════════ */
async function createCount(b, user) {
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('أدخل كمية مادة واحدة على الأقل');
  const ings = new Map((await Ingredient.find({ _id: { $in: b.lines.map((l) => l.ingredient).filter(isId) } }).lean()).map((i) => [String(i._id), i]));
  const lines = b.lines.slice(0, 300).map((l) => {
    const ing = ings.get(String(l.ingredient)); if (!ing) throw bad('مادة غير صحيحة');
    let factor; try { factor = factorFor(ing, l.unit || ing.baseUnit); } catch (e) { throw bad(e.message); }
    const counted = num(l.counted) * factor; if (!(counted >= 0)) throw bad(`كمية «${ing.name}» المعدودة غير صحيحة`);
    return { ingredient: ing._id, ingredientName: ing.name, baseUnit: ing.baseUnit, counted: r6(counted) };
  });
  const at = new Date();
  return StockCount.create({ number: await nextNo('count'), status: 'draft', countedAt: at, businessDay: await dayOf(at), lines, notes: String(b.notes || '').slice(0, 300), byName: (user && user.name) || '' });
}
/** اعتماد الجرد: المتوقع = رصيد الدفتر لحظة الاعتماد، والفرق حركة count — مرة واحدة فقط. */
async function postCount(id, user) {
  const claimed = await StockCount.findOneAndUpdate({ _id: id, status: 'draft' }, { $set: { status: 'posted', postedAt: new Date(), postedByName: (user && user.name) || '' } }, { new: true }).lean();
  if (!claimed) {
    const ex = await StockCount.findById(id).lean();
    if (!ex) throw bad('الجرد غير موجود', 404);
    throw bad('اعتُمد هذا الجرد مسبقاً', 409);
  }
  const ings = new Map((await Ingredient.find({ _id: { $in: claimed.lines.map((l) => l.ingredient) } }).lean()).map((i) => [String(i._id), i]));
  let shortage = 0; let surplus = 0;
  const lines = [];
  for (let k = 0; k < claimed.lines.length; k += 1) {
    const l = claimed.lines[k]; const ing = ings.get(String(l.ingredient)) || {};
    const expected = r6(ing.stockQty || 0); const diff = r6(l.counted - expected); const unitCost = ing.avgCost || 0; const value = r6(diff * unitCost);
    if (value < 0) shortage += -value; else surplus += value;
    lines.push({ ...l, expected, diff, unitCost, value });
    if (diff !== 0) await ledger.post({ key: `count:${claimed._id}:${k}`, ingredient: l.ingredient, ingredientName: l.ingredientName, type: 'count', qty: diff, unitCost, at: claimed.postedAt, businessDay: claimed.businessDay, refType: 'count', refId: String(claimed._id), byName: claimed.postedByName, reason: `جرد ${claimed.number}` });
  }
  await StockCount.updateOne({ _id: claimed._id }, { $set: { lines, shortageValue: r3(shortage), surplusValue: r3(surplus) } });
  return { ...claimed, lines, shortageValue: r3(shortage), surplusValue: r3(surplus) };
}

/* ═════════ تقارير المخزون ═════════ */
async function valuation() {
  const list = await Ingredient.find({ active: true }).sort({ category: 1, name: 1 }).lean();
  const ctx = makeCtx();
  const rows = [];
  for (const i of list) {
    let unitCost = i.avgCost || 0;
    if (!unitCost && i.kind === 'prep') unitCost = await prepUnitCost(ctx, i, null);
    const tracked = !(i.kind === 'prep' && i.trackMode === 'explode');
    rows.push({ _id: i._id, name: i.name, category: i.category, kind: i.kind, trackMode: i.trackMode, baseUnit: i.baseUnit, purchaseUnits: i.purchaseUnits, wastePct: i.wastePct,
      stockQty: tracked ? r6(i.stockQty || 0) : null, avgCost: r6(unitCost), lastCost: i.lastCost, lastCostAt: i.lastCostAt, minStock: i.minStock, supplier: i.supplier,
      value: tracked ? r3((i.stockQty || 0) * unitCost) : 0, low: tracked && i.minStock > 0 && (i.stockQty || 0) <= i.minStock, negative: tracked && (i.stockQty || 0) < -1e-6, noCost: !unitCost });
  }
  return { rows, total: r3(rows.reduce((s, r) => s + r.value, 0)) };
}

/** الاستهلاك النظري (من المبيعات والوجبات) مقابل الفعلي (من الجرد) لكل مادة بين تاريخين. */
async function usageReport(from, to) {
  const moves = await StockMovement.find({ at: { $gte: from, $lt: to } }).lean();
  const by = new Map();
  for (const m of moves) {
    const k = String(m.ingredient);
    if (!by.has(k)) by.set(k, { ingredient: m.ingredient, name: m.ingredientName, theoretical: 0, theoreticalValue: 0, received: 0, receivedValue: 0, waste: 0, wasteValue: 0, countDiff: 0, countValue: 0 });
    const r = by.get(k);
    if (['sale', 'sale_reversal', 'staff_meal', 'product_waste', 'prep_out'].includes(m.type)) { r.theoretical -= m.qty; r.theoreticalValue -= m.value; }
    else if (m.type === 'receive' || m.type === 'prep_in' || m.type === 'opening') { r.received += m.qty; r.receivedValue += m.value; }
    else if (m.type === 'waste' || m.type === 'expired') { r.waste -= m.qty; r.wasteValue -= m.value; }
    else if (m.type === 'count' || m.type === 'adjust') { r.countDiff += m.qty; r.countValue += m.value; }
  }
  const rows = [...by.values()].map((r) => {
    const actual = r.theoretical + r.waste - r.countDiff; // ما خرج فعلاً = النظري + الهدر + عجز الجرد
    return { ...r, theoretical: r6(r.theoretical), theoreticalValue: r3(r.theoreticalValue), received: r6(r.received), receivedValue: r3(r.receivedValue), waste: r6(r.waste), wasteValue: r3(r.wasteValue), countDiff: r6(r.countDiff), countValue: r3(r.countValue),
      actual: r6(actual), variancePct: r.theoretical > 0 ? r3(((actual - r.theoretical) / r.theoretical) * 100) : null };
  }).sort((a, b) => a.countValue - b.countValue);
  return { rows };
}

async function priceHistory(ingredientId, limit = 30) {
  return StockMovement.find({ ingredient: ingredientId, type: { $in: ['receive', 'opening'] } }).sort({ at: -1 }).limit(limit).select('at qty unitCost value reason refId byName').lean();
}

module.exports = {
  createIngredient, updateIngredient, saveRecipe, createReceipt, ingredientMovement, produceBatch,
  internalUse, createCount, postCount, valuation, usageReport, priceHistory, bad,
};
