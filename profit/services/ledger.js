/**
 * كتابة حركة مخزون واحدة بشكل آمن ومتكرر (idempotent):
 *   المفتاح الفريد يمنع تكرار الحركة — إن وُجدت مسبقاً لا يتغيّر الرصيد ثانية.
 *   الرصيد المخزَّن يتحدّث بـ $inc ذرّي فقط بعد نجاح إدراج الحركة.
 */
const StockMovement = require('../models/StockMovement');
const Ingredient = require('../models/Ingredient');

const r6 = (n) => Math.round(n * 1e6) / 1e6;

async function post(m) {
  const doc = { ...m, qty: r6(m.qty), unitCost: r6(m.unitCost || 0), value: r6((m.qty || 0) * (m.unitCost || 0)) };
  try {
    await StockMovement.create(doc);
  } catch (e) {
    if (e && e.code === 11000) return { duplicate: true };
    throw e;
  }
  await Ingredient.updateOne({ _id: m.ingredient }, { $inc: { stockQty: doc.qty } });
  return { duplicate: false, movement: doc };
}

/**
 * استلام: يُحدّث متوسط التكلفة المرجّح قبل الإدخال.
 *   الجديد = (الرصيد × المتوسط + الكمية × السعر) ÷ (الرصيد + الكمية)
 *   رصيد سالب أو صفر ← المتوسط = سعر الاستلام (لا معنى لمتوسط على رصيد غير موجود)
 */
async function receive({ key, ingredient, qty, unitCost, at, businessDay, refType, refId, byName, reason }) {
  const exists = await StockMovement.exists({ key });
  if (exists) return { duplicate: true };
  const ing = await Ingredient.findById(ingredient).lean();
  if (!ing) throw new Error('المادة غير موجودة');
  const onHand = Math.max(0, ing.stockQty || 0);
  const avg = onHand > 0 && ing.avgCost > 0 ? (onHand * ing.avgCost + qty * unitCost) / (onHand + qty) : unitCost;
  const res = await post({ key, ingredient, ingredientName: ing.name, type: 'receive', qty, unitCost, at, businessDay, refType, refId, byName, reason });
  if (!res.duplicate) {
    await Ingredient.updateOne({ _id: ingredient }, { $set: { avgCost: r6(avg), lastCost: r6(unitCost), lastCostAt: at || new Date() } });
  }
  return res;
}

module.exports = { post, receive, r6 };
